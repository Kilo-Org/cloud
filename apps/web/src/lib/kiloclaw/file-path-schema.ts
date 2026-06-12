import * as z from 'zod';

export const KILOCLAW_FILE_PATH_MAX_LENGTH = 4096;

export const kiloclawFilePathSchema = z.string().min(1).max(KILOCLAW_FILE_PATH_MAX_LENGTH);
