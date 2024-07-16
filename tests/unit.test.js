// @ts-nocheck
import { BigQuery } from "@google-cloud/bigquery";
import { Storage } from "@google-cloud/storage";
import {
	aggregateImportResults,
	process_request_params,
	build_sql_query
} from "../index";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
dayjs.extend(utc);
const LONG_TIMEOUT = 1000 * 60 * 5; // 5 minutes


// import dotenv from "dotenv";
// dotenv.config({ override: true, path: ".env.tests" });
// let { BQ_DATASET_ID, BQ_TABLE_ID, GCS_BUCKET, MP_TOKEN, INTRADAY, NUM_ROWS, MP_SECRET } = process.env;
// NUM_ROWS = parseInt(NUM_ROWS);
// INTRADAY = strToBool(INTRADAY);
// global.MP_TOKEN = MP_TOKEN;
// global.MP_SECRET = MP_SECRET;
// global.BQ_DATASET_ID = BQ_DATASET_ID;
// global.BQ_TABLE_ID = BQ_TABLE_ID;
// global.GCS_BUCKET = GCS_BUCKET;
// global.INTRADAY = INTRADAY;
// global.NUM_ROWS = NUM_ROWS;




describe('summarize', () => {
	test('empty', () => {
		const results = [];
		const summary = aggregateImportResults(results);
		expect(summary).toEqual({
			success: 0,
			failed: 0,
			total: 0,
			eps: 0,
			mbps: 0,
			rps: 0,
			bytes: 0,
			duration: 0,
			rateLimit: 0,
			clientErrors: 0,
			serverErrors: 0,
			batches: 0,
			requests: 0,
			retries: 0,
			errors: [],
			duplicates: 0
		});
	});

	test('adds + avgs', () => {
		const results = [
			{ success: 10, failed: 2, total: 12, eps: 100, mbps: 2, rps: 5, bytes: 500, duration: 10, rateLimit: 1, clientErrors: 0, serverErrors: 1, batches: 3, requests: 5, retries: 1, errors: ["Error 1"], duplicates: 0 },
			{ success: 15, failed: 3, total: 18, eps: 150, mbps: 3, rps: 7, bytes: 700, duration: 12, rateLimit: 2, clientErrors: 1, serverErrors: 0, batches: 4, requests: 6, retries: 2, errors: ["Error 2"], duplicates: 1 }
		];
		const summary = aggregateImportResults(results);

		expect(summary.success).toBe(25);
		expect(summary.failed).toBe(5);
		expect(summary.total).toBe(30);
		expect(summary.eps).toBe(125); // Average of 100 and 150
		expect(summary.mbps).toBe(2.5); // Average of 2 and 3
		expect(summary.rps).toBe(6); // Average of 5 and 7
		expect(summary.bytes).toBe(1200);
		expect(summary.duration).toBe(22);
		expect(summary.rateLimit).toBe(3);
		expect(summary.clientErrors).toBe(1);
		expect(summary.serverErrors).toBe(1);
		expect(summary.batches).toBe(7);
		expect(summary.requests).toBe(11);
		expect(summary.retries).toBe(3);
		expect(summary.errors).toEqual(["Error 1", "Error 2"]);
		expect(summary.duplicates).toBe(1);
	});


});


describe("process req params", () => {

	test("produces valid qs", () => {
		const mockReq = {
			query: {
				table: "newTableId",
				dataset: "newDatasetId",
				bucket: "newGCSBucket",
				token: "newMPToken",
				date: "20210101"
			},
			get: () => { 'localhost'; }
		};

		const queryString = process_request_params(mockReq);

		// Check that the query string is correct
		expect(queryString).toBe("table=newTableId&dataset=newDatasetId&bucket=newGCSBucket&token=newMPToken&date=20210101");
	});


});


describe("build_sql_query", () => {
	test("intraday", async () => {
		const query = await build_sql_query("my_dataset", "my_table", true);
		const expected = `SELECT * FROM \`my_dataset.events_intraday_*\` WHERE ((TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(CAST(event_timestamp / 1000 as INT64)), SECOND) <= 3600) OR (event_server_timestamp_offset > 60000000 AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(CAST(event_timestamp / 1000 as INT64)), SECOND) <= 7200))`
		expect(query).toBe(expected);
	});

	test("full-day", async () => {
		const query = await build_sql_query("my_dataset", "my_table");

		expect(query).toBe("SELECT * FROM `my_dataset.my_table`");
	});

	test("user properties", async () => {
		const query = await build_sql_query("my_dataset", "my_table", false, 3600, 60, "user");

		expect(query).toBe("SELECT * FROM `my_dataset.my_table` WHERE user_properties IS NOT NULL");
	});

	test("custom sql", async () => {
		const customSQL = "SELECT user_id, event_name";
		const query = await build_sql_query("my_dataset", "my_table", false, 3600, 60, "event", customSQL);

		expect(query).toBe("SELECT user_id, event_name FROM `my_dataset.my_table`");
	});
});


