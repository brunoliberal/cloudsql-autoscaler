locals {
  gh_pat_secret = "<REPLACE_WITH_SECRET_MANAGER_GITHUB_SECRET_PATH>"
  cloudbuild_sa = "<REPLACE_WITH_CLOUD_BUILD_SERVICE_ACCOUNT>"
}

data "google_secret_manager_secret_version" "github_token_secret_version" {
  secret = local.gh_pat_secret
}

resource "google_cloudbuildv2_connection" "gh_connection" {
  project  = var.project_id
  location = "australia-southeast1"
  name     = "github-connection"

  github_config {
    app_installation_id = 58328748
    authorizer_credential {
      oauth_token_secret_version = data.google_secret_manager_secret_version.github_token_secret_version.id
    }
  }
}

resource "google_cloudbuildv2_repository" "autoscaler_repository" {
  project           = var.project_id
  location          = "australia-southeast1"
  name              = "autoscaler-infra"
  parent_connection = google_cloudbuildv2_connection.gh_connection.name
  remote_uri        = "<REPLACE_WITH_GITHUB_REMOTE_URI>"
}

data "google_service_account" "cloudbuild_sa" {
  account_id = local.cloudbuild_sa
}

# Triggers
resource "google_cloudbuild_trigger" "autoscaler_main" {
  project            = var.project_id
  filename           = "cloudbuild.yaml"
  include_build_logs = "INCLUDE_BUILD_LOGS_WITH_STATUS"
  location           = "australia-southeast1"
  name               = "gcp-cloudsql-autoscaler-main"
  service_account    = data.google_service_account.cloudbuild_sa.id
  tags = [
    "autoscaler-infra",
    "main",
  ]

  repository_event_config {
    repository = google_cloudbuildv2_repository.autoscaler_repository.id

    push {
      branch = "^main$"
    }
  }
}
resource "google_cloudbuild_trigger" "autoscaler_feature" {
  project            = var.project_id
  filename           = "cloudbuild.yaml"
  include_build_logs = "INCLUDE_BUILD_LOGS_WITH_STATUS"
  location           = "australia-southeast1"
  name               = "gcp-cloudsql-autoscaler-feature"
  service_account    = data.google_service_account.cloudbuild_sa.id
  tags = [
    "autoscaler-infra",
    "feature",
  ]

  repository_event_config {
    repository = google_cloudbuildv2_repository.autoscaler_repository.id

    pull_request {
      branch = "^main$"
    }
  }
}