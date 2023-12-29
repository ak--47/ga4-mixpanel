// @ts-nocheck
import { exec } from "child_process";
import { strToBool } from "../index";
import { sleep } from "ak-tools";
import kill from "tree-kill";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import fetch from "node-fetch";
import { spawn } from "child_process";
import net from "net";
dayjs.extend(utc);
import dotenv from "dotenv";
dotenv.config({ override: true, path: ".env.tests" });
const LONG_TIMEOUT = 1000 * 60 * 5; // 5 minutes
let { BQ_DATASET_ID, BQ_TABLE_ID, GCS_BUCKET, MP_TOKEN, INTRADAY, NUM_ROWS, MP_SECRET } = process.env;

NUM_ROWS = parseInt(NUM_ROWS);
INTRADAY = strToBool(INTRADAY);

function checkServerRunning(port = 8080) {
	return new Promise((resolve, reject) => {
		const testServer = net
			.createServer()
			.once("error", (err) => (err.code === "EADDRINUSE" ? resolve(true) : reject(err)))
			.once("listening", () => testServer.once("close", () => resolve(false)).close())
			.listen(port);
	});
}

let serverProcess;

beforeAll(async () => {
	const isRunning = await checkServerRunning(8080);

	if (!isRunning) {
		serverProcess = spawn("npm", ["run", "mock"]);

		// Wait for the server to be ready
		await new Promise((resolve, reject) => {
			serverProcess.stdout.on("data", (data) => {
				sleep(1000).then(() => resolve());
			});

			serverProcess.stderr.on("data", (data) => {
				console.error(`stderr: ${data}`);
			});

			serverProcess.on("error", (error) => {
				console.error(`Failed to start server: ${error}`);
				reject(error);
			});
		});
	} else {
		console.log("Server already running. Skipping server start.");
	}
}, LONG_TIMEOUT);

afterAll(() => {
	if (serverProcess) {
		kill(serverProcess.pid);
	}
});

describe("Cloud Function E2E Tests", () => {
	const url = `http://localhost:8080`;
	let qs = `?`;

	test(
		"NO PARAMS",
		async () => {
			const response = await fetch(url + qs);
			const json = await response.json();
			expect(response.status).toBe(500);
			expect(json.error).toBe("MP_TOKEN or MP_SECRET is required");
		},
		LONG_TIMEOUT
	);

	test(
		"JUST TOKEN",
		async () => {
			qs = `?token=${MP_TOKEN}`;
			const response = await fetch(url + qs);
			const json = await response.json();
			expect(response.status).toBe(500);
			expect(json.error).toBe(`Table \"events_intraday_*\" must be qualified with a dataset (e.g. dataset.table).`);
		},
		LONG_TIMEOUT
	);

	test(
		"MVP (events)",
		async () => {
			qs = `?token=${MP_TOKEN}&secret=${MP_SECRET}&dataset=${BQ_DATASET_ID}&table=${BQ_TABLE_ID}&bucket=${GCS_BUCKET}&intraday=false`;
			const response = await fetch(url + qs);
			const job = await response.json();
			expect(response.status).toBe(200);
			const { files_failed, files_success, files_total } = job;
			expect(files_failed).toBe(0);
			expect(files_success).toBe(1);
			expect(files_total).toBe(1);
			const { batches, errors, failed, success, total } = job.summary;
			expect(batches).toBe(8);
			expect(errors.length).toBe(0);
			expect(failed).toBe(0);
			expect(success).toBe(NUM_ROWS);
			expect(total).toBe(NUM_ROWS);
		},
		LONG_TIMEOUT
	);

	test(
		"MVP (users)",
		async () => {
			qs = `?type=user&token=${MP_TOKEN}&secret=${MP_SECRET}&dataset=${BQ_DATASET_ID}&table=${BQ_TABLE_ID}&bucket=${GCS_BUCKET}&intraday=false`;
			const response = await fetch(url + qs);
			const job = await response.json();
			expect(response.status).toBe(200);
			const { files_failed, files_success, files_total } = job;
			expect(files_failed).toBe(0);
			expect(files_success).toBe(1);
			expect(files_total).toBe(1);

			const { batches, errors, failed, success, total, duplicates } = job.summary;
			expect(batches).toBe(4);
			expect(errors.length).toBe(0);
			expect(failed).toBe(0);
			expect(duplicates).toBe(9069);
			expect(success).toBe(0); // something wrong here...
			expect(total).toBe(NUM_ROWS);
		},
		LONG_TIMEOUT
	);
});
