/// <reference types="node" />

import "../src/config.js";
import { z } from "zod";
import { prisma } from "../src/db.js";
import { hashPassword, normalizeEmail } from "../src/modules/auth/service.js";

const adminCredentialsSchema = z.object({
  ADMIN_EMAIL: z.string().trim().email().transform(normalizeEmail),
  ADMIN_PASSWORD: z.string().min(1, "ADMIN_PASSWORD is required"),
});

const credentials = adminCredentialsSchema.safeParse(process.env);

if (!credentials.success) {
  throw new Error(
    "Invalid seed configuration. Set a valid ADMIN_EMAIL and non-empty ADMIN_PASSWORD in backend/.env.",
  );
}

try {
  const existingAdmin = await prisma.user.findFirst({
    where: { role: "admin" },
    select: { id: true },
  });

  if (existingAdmin) {
    console.info("An admin account already exists; no changes made.");
  } else {
    const hashedPassword = await hashPassword(credentials.data.ADMIN_PASSWORD);
    await prisma.user.create({
      data: {
        email: credentials.data.ADMIN_EMAIL,
        name: "Admin",
        role: "admin",
        hashedPassword,
      },
    });
    console.info("Initial admin account created.");
  }
} catch {
  console.error("Could not seed the initial admin account.");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
