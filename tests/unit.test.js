// exportQueryResultToGCS.test.js

import { BigQuery } from '@google-cloud/bigquery';
import { Storage } from '@google-cloud/storage';
import { exportQueryResultToGCS } from '../index'; // Adjust the path

jest.mock('@google-cloud/bigquery');
jest.mock('@google-cloud/storage');

describe('exportQueryResultToGCS', () => {
    test('should export data to GCS successfully', async () => {
        // Mock BigQuery and Storage behavior
        const mockQueryJob = {
            getMetadata: jest.fn().mockResolvedValue([{ status: { state: 'DONE' } }]),
        };
        BigQuery.prototype.createQueryJob = jest.fn().mockResolvedValue([mockQueryJob]);
        Storage.prototype.bucket = jest.fn().mockReturnThis();
        Storage.prototype.file = jest.fn().mockReturnThis();
        Storage.prototype.extract = jest.fn().mockResolvedValue();

        const query = 'SELECT * FROM `dataset.table`';
        await expect(exportQueryResultToGCS(query)).resolves.not.toThrow();
        expect(BigQuery.prototype.createQueryJob).toHaveBeenCalledWith({ /* your jobConfig */ });
        // Add more assertions as needed
    });
});
