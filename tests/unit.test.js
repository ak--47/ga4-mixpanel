// @ts-nocheck
import { BigQuery } from "@google-cloud/bigquery";
import { Storage } from "@google-cloud/storage";

import {	
	strToBool,
	aggregateImportResults,
} from "../index";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
dayjs.extend(utc);
import dotenv from "dotenv";
dotenv.config();



describe('string to bool', () => {
    test('"true"', () => {
        expect(strToBool('true')).toBe(true);
    });

    test('"yes"', () => {
        expect(strToBool('yes')).toBe(true);
    });

    test('"1"', () => {
        expect(strToBool('1')).toBe(true);
    });

    test('"false"', () => {
        expect(strToBool('false')).toBe(false);
    });

    test('"no"', () => {
        expect(strToBool('no')).toBe(false);
    });

    test('"0"', () => {
        expect(strToBool('0')).toBe(false);
    });

    test('empty string', () => {
        expect(strToBool('')).toBe(false);
    });

    test('non-string', () => {
        expect(strToBool(null)).toBe(false);
        expect(strToBool(undefined)).toBe(false);
        expect(strToBool(0)).toBe(false);
        expect(strToBool(1)).toBe(true);
    });

    test('whitespace', () => {
        expect(strToBool('  true  ')).toBe(true);
    });

    test('mix case', () => {
        expect(strToBool('TrUe')).toBe(true);
        expect(strToBool('FaLsE')).toBe(false);
    });

    test('non-empty', () => {
        expect(strToBool('hello')).toBe(true);
        expect(strToBool('123')).toBe(true);
    });

});

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