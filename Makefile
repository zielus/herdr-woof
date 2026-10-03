.PHONY: build test race vet check integration install-test clean

build:
	go build -o bin/woof ./cmd/woof
	go build -o bin/woofd ./cmd/woofd
test:
	go test ./...
race:
	go test -race ./...
vet:
	go vet ./...
check: build test race vet
integration: build
	./scripts/integration.sh
install-test: build
	./scripts/install-test.sh
clean:
	rm -f bin/woof bin/woofd
