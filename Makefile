CLUSTER        ?= learning
BACKEND_IMAGE  ?= demo-backend:dev
FRONTEND_IMAGE ?= demo-frontend:dev
PORT           ?= 8088

.PHONY: build load deploy up access status logs clean

build:
	docker build -t $(BACKEND_IMAGE) backend
	docker build -t $(FRONTEND_IMAGE) frontend

load:
	kind load docker-image $(BACKEND_IMAGE) --name $(CLUSTER)
	kind load docker-image $(FRONTEND_IMAGE) --name $(CLUSTER)

deploy:
	kubectl apply -k k8s

up: build load deploy

access:
	kubectl -n demo port-forward svc/frontend $(PORT):80

status:
	kubectl -n demo get deploy,svc,pods,hpa

logs:
	kubectl -n demo logs -l app=backend --tail=50 --prefix

clean:
	kubectl delete -k k8s --ignore-not-found
