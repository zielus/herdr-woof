.PHONY: build test race vet lint fmt vuln check integration install-test clean

build:
	go build -o bin/woof ./cmd/woof
	go build -o bin/woofd ./cmd/woofd
test:
	go test ./...
race:
	go test -race ./...
vet:
	go vet ./...
lint:
	sh scripts/lint.sh run
fmt:
	sh scripts/lint.sh fmt
vuln:
	go run golang.org/x/vuln/cmd/govulncheck@v1.1.4 ./...
check: build test race vet lint
integration: build
	./scripts/integration.sh
install-test: build
	./scripts/install-test.sh
clean:
	rm -f bin/woof bin/woofd
