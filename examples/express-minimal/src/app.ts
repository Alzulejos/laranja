import express from "express";

export const app = express();

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    service: "express-minimal",
    stage: process.env.STAGE ?? "local",
    message: "Hello from laranja 🍊",
    time: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
