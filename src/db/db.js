import { PrismaClient } from "@prisma/client";
import { log } from "../utils/logger.js";

const prisma = new PrismaClient();

// Test the connection
prisma.$connect()
  .then(() => log.db("Connected to Supabase PostgreSQL via Prisma"))
  .catch((err) => log.error("Prisma connection error:", err.message));

export const db = prisma;
