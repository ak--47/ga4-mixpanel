#!/bin/bash
PROJECT_ID=$(gcloud config get-value project)
gcloud builds submit --tag gcr.io/${PROJECT_ID}/ga4-mixpanel-run .
gcloud run deploy ga4-mixpanel-run --image gcr.io/${PROJECT_ID}/ga4-mixpanel-run --region us-central1 --no-allow-unauthenticated --memory 2Gi --cpu 1 --concurrency 5
