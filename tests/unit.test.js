// exportQueryResultToGCS.test.js

import { BigQuery } from '@google-cloud/bigquery';
import { Storage } from '@google-cloud/storage';
import { buildSQLQuery } from '../index'; // Adjust the path
import { Parser} from 'node-sql-parser';
const parser = new Parser();
const ast = parser.astify('SELECT * FROM t', {database: "bigquery"});
debugger;

// jest.mock('@google-cloud/bigquery');
// jest.mock('@google-cloud/storage');

// describe('exportQueryResultToGCS', () => {
//     test('should export data to GCS successfully', async () => {
//         // Mock BigQuery and Storage behavior
//         const mockQueryJob = {
//             getMetadata: jest.fn().mockResolvedValue([{ status: { state: 'DONE' } }]),
//         };
//         BigQuery.prototype.createQueryJob = jest.fn().mockResolvedValue([mockQueryJob]);
//         Storage.prototype.bucket = jest.fn().mockReturnThis();
//         Storage.prototype.file = jest.fn().mockReturnThis();
//         Storage.prototype.extract = jest.fn().mockResolvedValue();

//         const query = 'SELECT * FROM `dataset.table`';
//         await expect(exportQueryResultToGCS(query)).resolves.not.toThrow();
//         expect(BigQuery.prototype.createQueryJob).toHaveBeenCalledWith({ /* your jobConfig */ });
//         // Add more assertions as needed
//     });
// });


describe('buildSQLQuery', () => {
    // Test default parameters
    test('should handle default parameters correctly', async () => {
        const query = await buildSQLQuery('some_table');
        expect(query).toContain('some_table');
        // Additional assertions to validate the structure of the query
    });

    // Test intraday variations
    describe('intraday variations', () => {
        test('should handle intraday=true correctly', async () => {
            const query = await buildSQLQuery('some_table', true);
            expect(query).toContain('events_intraday_*');
            // Additional assertions for intraday=true case
        });

        test('should handle intraday=false correctly', async () => {
            const query = await buildSQLQuery('some_table', false);
            expect(query).toContain('some_table');
            // Additional assertions for intraday=false case
        });
    });

    // Test lookBackWindow variations
    test('should handle different lookBackWindow values', async () => {
        const query = await buildSQLQuery('some_table', false, 7200);
        expect(query).toContain('7200');
        // Additional assertions for different lookBackWindow values
    });

    // Test late variations
    test('should handle different late values', async () => {
        const query = await buildSQLQuery('some_table', false, 3600, 120);
        expect(query).toContain('120');
        // Additional assertions for different late values
    });

    // Test type variations
    describe('type variations', () => {
        test('should handle type="event" correctly', async () => {
            const query = await buildSQLQuery('some_table', false, 3600, 60, 'event');
            // Assertions for type="event"
        });

        test('should handle type="user" correctly', async () => {
            const query = await buildSQLQuery('some_table', false, 3600, 60, 'user');
            // Assertions for type="user"
        });
    });

    // Test combinations of parameters
    test('should handle combinations of parameters correctly', async () => {
        const query = await buildSQLQuery('some_table', true, 7200, 120, 'user');
        // Assertions for combined parameters
    });
});