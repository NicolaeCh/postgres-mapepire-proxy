.PHONY: install build test run container
install:
	npm install
build:
	npm run build
test:
	npm test
run:
	npm run dev
container:
	podman build -f Containerfile -t postgres-mapepire-proxy:0.1.0 .
