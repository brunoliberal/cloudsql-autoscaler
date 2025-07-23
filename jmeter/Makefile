# Update the varibles below to connect to the bastion host
GCE_VM := "XXXXXX"
PROJECT_ID := "XXXXXX"
ZONE := "XXXXXX"
SA := "XXXXXX"

.PHONY: start-tunnel
start-tunnel:  ## Start tunnel to the bastion host connected with CloudSQL
	@echo "Starting IAP Tunnel..."
	@gcloud compute ssh $(GCE_VM) \
		--project=$(PROJECT_ID) \
		--zone=$(ZONE) \
		--impersonate-service-account=$(SA) \
		--tunnel-through-iap \
		--ssh-flag="-L 3306:localhost:3306"

.PHONY: initial-load
initial-load:  ## Run the initial load
	@echo "Running Initial Load..."
	@jmeter -q credentials.properties -n -t jmeter-autoscaler-cloudsql-intial-load.jmx -l load-out.csv -Jusers=1000 -Jiterations=1000

.PHONY: perf-test
perf-test:  ## Run the performance test
	@echo "Running Performance Test..."
	@jmeter -q credentials.properties -n -t jmeter-autoscaler-cloudsql-performance-test.jmx -l test-out.csv -Jusers=100 -Jduration=900

.PHONY: report
report:  ## Create the report from the performance test
	@echo "Creating Report..."
	@jmeter -g test-out.csv -o report/

.PHONY: clean
clean:  ## Delete generated resources
	@echo "Cleaning generated resources..."
	@rm -rf load-out.csv test-out.csv jmeter.log report/

.PHONY: help
.DEFAULT_GOAL := help

help:
	@echo "This file contains targets to support CloudSQL performance testing"
	@fgrep -h "##" $(MAKEFILE_LIST) | sed -e 's/\(\:.*\#\#\)/\:\ /' | fgrep -v fgrep | sed -e 's/\\$$//' | sed -e 's/##//'