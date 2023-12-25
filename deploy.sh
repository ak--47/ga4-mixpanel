PROJECT_ID=$(gcloud config get-value project)
gcloud builds submit --tag gcr.io/${PROJECT_ID}/ga4-mixpanel
gcloud run deploy ga4-mixpanel --image gcr.io/${PROJECT_ID}/ga4-mixpanel