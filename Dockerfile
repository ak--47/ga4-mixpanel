# Use an official Node.js runtime as a parent image
FROM node:20

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy the current directory contents into the container at /usr/src/app
COPY . .

# Install any needed packages specified in package.json
RUN npm install

# Make port 8080 available to the world outside this container
EXPOSE 8080

# Define environment variables
ENV GCP_PROJECT=your_project_id
ENV BQ_DATASET_ID=your_dataset_id
ENV GCS_BUCKET=your_bucket_name
ENV MP_TOKEN=your_mp_token
ENV URL=your_url

# Start the Functions Framework to serve your function
CMD ["node", "node_modules/@google-cloud/functions-framework", "--target=go", "--signature-type=http"]

