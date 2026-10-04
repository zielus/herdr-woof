.PHONY: build test race vet lint fmt vuln check integration install-test licenses release-check dist clean

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
check: build test race vet lint release-check
integration: build
	./scripts/integration.sh
install-test: build
	./scripts/install-test.sh
	sh scripts/plugin-build-test.sh
licenses:
	sh scripts/licenses.sh
release-check:
	sh scripts/version.sh --check
	sh scripts/licenses.sh --check
dist:
	sh scripts/dist.sh
clean:
	rm -rf bin/woof bin/woofd dist
