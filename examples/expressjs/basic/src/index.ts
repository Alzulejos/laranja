import express from "express";
import { env, getQueue, http } from "@alzulejos/laranja-decorators";
import dashboardRouter from "./routes/dashboard";

const PORT = 3001;
const app = express();
app.use(express.json());
app.get("", (req, res) => {
  return res.json({ message: `Laranja with express` });
});

app.get("/env", (req, res) => {
  return res.json({ message: `Reading env variable value ${env("TEST_ENV")}` });
});

app.post("/register", async (req, res) => {
  try {
    await getQueue("welcomeEmail").send({
      userEmail: req.body.userEmail ?? "",
    });
  } catch (e) {
    return res.status(500).json({ error: "failed to enqueue" });
  }
  return res.status(200).json({ ok: true });
});

app.use("/dashboard", dashboardRouter);

app.listen(PORT, () => {
  console.log(`Running on ${PORT} 🚀`);
});

export default http(app);
