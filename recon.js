import http from "http";
import { cLog } from "ak-tools";

let cachedMetadata = {};

async function httpRequest(options) {
	return new Promise((resolve, reject) => {
		const req = http.request(options, (res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				if (res.statusCode === 200) {
					resolve(JSON.parse(data));
				} else {
					resolve({});
					// reject(new Error(`Request Failed. Status Code: ${res.statusCode}`));
				}
			});
		});

		req.on("error", () => {
			resolve({});
		});
		req.end();
	});
}

async function getMetadata(path = "", recursive = false) {
	const options = {
		hostname: "metadata.google.internal",
		port: 80,
		path: `/computeMetadata/v1/${path}?recursive=${recursive}&alt=json`,
		method: "GET",
		headers: {
			"Metadata-Flavor": "Google",
		},
	};

	return httpRequest(options);
}

async function gatherInstanceMetadata() {
	const instanceId = await getMetadata("instance/id");
	const machineType = await getMetadata("instance/machine-type");
	const zone = await getMetadata("instance/zone");
	const hostname = await getMetadata("instance/hostname");
	const attributes = await getMetadata("instance/attributes/", true);
	const allMetadata = await getMetadata("instance/", true);

	return { instanceId, machineType, zone, allMetadata };
}

async function gatherNetworkMetadata() {
	const networkInterfaces = await getMetadata("instance/network-interfaces/", true);
	return { networkInterfaces };
}

async function gatherProjectMetadata() {
	const projectId = await getMetadata("project/project-id");
	const projectNumber = await getMetadata("project/numeric-project-id");
	const projectAttributes = await getMetadata("project/attributes/", true);

	return { projectId, projectNumber, projectAttributes };
}


async function gatherMetadata() {
	try {
		cachedMetadata.instance = await gatherInstanceMetadata();
		cachedMetadata.network = await gatherNetworkMetadata();
		cachedMetadata.project = await gatherProjectMetadata();
		cachedMetadata.env = process.env; // Environment variables are not expected to change

		// Log the collected metadata
		cLog(cachedMetadata, "Collected Metadata:");

		return cachedMetadata;
	} catch (e) {
		cLog(e.message, "Error gathering metadata:");
		return cachedMetadata; // Return the cached metadata anyway		
	}
}

async function main() {
	try {
		return await gatherMetadata();
	} catch (error) {
		// Handle errors that may have occurred during metadata gathering
		cLog("UNKNOWN ERROR:", error, "CRITICAL");
		return { "error": error.message, "stack": error.stack };
	}
}

export default main;
