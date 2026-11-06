import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().optional(),
  JWT_SECRET: z
    .string()
    .trim()
    .min(32, "JWT_SECRET must be at least 32 characters"),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  FRONTEND_ORIGIN: z.string().trim().url().default("http://localhost:5173"),
  FRONTEND_URL: z.string().trim().url().default("http://localhost:5173"),
  HOCUSPOCUS_PORT: z.coerce.number().int().min(1).max(65535).default(1234),
  LIVEKIT_URL: z.string().trim().url("LIVEKIT_URL must be a valid URL"),
  LIVEKIT_API_KEY: z.string().trim().min(1, "LIVEKIT_API_KEY is required"),
  LIVEKIT_API_SECRET: z.string().trim().min(1, "LIVEKIT_API_SECRET is required"),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_ENDPOINT_URL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
});

const result = environmentSchema.safeParse(process.env);

if (!result.success) {
  const missingValues = result.error.issues
    .map((issue) => issue.path.join("."))
    .filter((name, index, names) => names.indexOf(name) === index);

  throw new Error(
    `Invalid environment configuration. Set the required value(s): ${missingValues.join(", ")}`,
  );
}

export const config = result.data;
