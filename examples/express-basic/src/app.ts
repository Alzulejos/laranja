import express from "express";

export const app = express();

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    service: "express-basic",
    stage: process.env.STAGE ?? "local",
    message: "Hello from laranja 🍊",
    time: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/users/:id", (req, res) => {
  res.json({ id: req.params.id, name: `User ${req.params.id}` });
});

app.post("/users", (req, res) => {
  res.status(201).json({ created: true, body: req.body });
});
