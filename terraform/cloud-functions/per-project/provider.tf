terraform {
  backend "gcs" {
    bucket                      = "<REPLACE_WITH_IAC_BUCKET>"
    impersonate_service_account = "<REPLACE_WITH_IAC_SERVICE_ACCOUNT>"
  }
}
provider "google" {
  impersonate_service_account = "<REPLACE_WITH_IAC_SERVICE_ACCOUNT>"
}
provider "google-beta" {
  impersonate_service_account = "<REPLACE_WITH_IAC_SERVICE_ACCOUNT>"
}