import express from "express";
import { http } from "@laranja/decorators";

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ service: "express-codefirst", message: "Hello from laranja 🍊" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Code-first marker: this is the proxy target. No `entry` needed in config.
export default http(app);
