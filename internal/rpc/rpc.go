// Package rpc implements Woof NDJSON requests, one request per Unix connection.
// Adapted from herdr-orch (MIT, Copyright (c) 2026 Stephen Ellington).
package rpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/zielus/herdr-woof/internal/model"
	"io"
	"net"
	"time"
)

var ErrUnavailable = errors.New("daemon unavailable; request not sent")
var ErrLost = errors.New("connection lost; request outcome unknown")

func writeRequest(w io.Writer, b []byte) error {
	n, err := w.Write(b)
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	if err != nil {
		if n == 0 {
			return errors.Join(ErrUnavailable, err)
		}
		return errors.Join(ErrLost, err)
	}
	return nil
}
func connect(ctx context.Context, sock string, req model.Request) (net.Conn, func(), error) {
	if req.Version != model.Protocol && req.Version != model.ExtraArgsProtocol {
		return nil, nil, fmt.Errorf("request protocol %d unsupported", req.Version)
	}
	b, err := json.Marshal(req)
	if err != nil {
		return nil, nil, err
	}
	dctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	c, err := (&net.Dialer{}).DialContext(dctx, "unix", sock)
	if err != nil {
		return nil, nil, errors.Join(ErrUnavailable, err)
	}
	// Closing only releases the transport; the response or send failure already
	// determines the outcome. Cancellation may race with normal cleanup.
	closeConn := func() { _ = c.Close() }
	stop := context.AfterFunc(ctx, closeConn)
	cleanup := func() { stop(); closeConn() }
	if err = writeRequest(c, append(b, '\n')); err != nil {
		cleanup()
		return nil, nil, err
	}
	return c, cleanup, nil
}
func lost(ctx context.Context, err error) error { return errors.Join(ErrLost, err, ctx.Err()) }
func response(ctx context.Context, r *bufio.Reader) (model.Response, error) {
	line, err := r.ReadBytes('\n')
	if err != nil {
		return model.Response{}, lost(ctx, err)
	}
	var resp model.Response
	if err = json.Unmarshal(line, &resp); err != nil {
		return resp, lost(ctx, err)
	}
	if resp.Version != model.Protocol {
		return resp, lost(ctx, fmt.Errorf("response protocol %d unsupported", resp.Version))
	}
	if !resp.OK {
		if resp.Error == nil {
			return resp, lost(ctx, errors.New("response missing error"))
		}
		return resp, resp.Error
	}
	return resp, nil
}
func Call(ctx context.Context, sock string, req model.Request, out any) error {
	c, cleanup, err := connect(ctx, sock, req)
	if err != nil {
		return err
	}
	defer cleanup()
	resp, err := response(ctx, bufio.NewReaderSize(c, 1<<20))
	if err != nil {
		return err
	}
	if out != nil && len(resp.Result) > 0 {
		if err = json.Unmarshal(resp.Result, out); err != nil {
			return lost(ctx, err)
		}
	}
	return nil
}
func Stream(ctx context.Context, sock string, req model.Request, fn func(json.RawMessage) error) error {
	c, cleanup, err := connect(ctx, sock, req)
	if err != nil {
		return err
	}
	defer cleanup()
	r := bufio.NewReaderSize(c, 1<<20)
	for {
		resp, err := response(ctx, r)
		if err != nil {
			return err
		}
		if err = fn(resp.Result); err != nil {
			return err
		}
	}
}
