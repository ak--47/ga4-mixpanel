PROJECT_ID=$(gcloud config get-value project)
gcloud functions deploy ga4-mixpanel-func --gen2 --runtime nodejs20 --region us-central1 --trigger-http --memory 2GB --cpu 1 --entry-point go --source . --timeout=3600 --no-allow-unauthenticated --max-instances=1000 --min-instances=0 --concurrency=5 --project ${PROJECT_ID}
