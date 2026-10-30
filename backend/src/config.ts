import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required"),
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
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
