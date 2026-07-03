import express from "express";
import { env, http } from "@alzulejos/laranja-decorators";
import dashboardRouter from "./routes/dashboard";

const PORT = 3001;
const app = express();

app.get("", (req, res) => {
  return res.json({ message: `Laranja with express` });
});

app.get("/env", (req, res) => {
  return res.json({ message: `Reading env variable value ${env("TEST_ENV")}` });
});

app.use("/dashboard", dashboardRouter);

app.listen(PORT, () => {
  console.log(`Running on ${PORT} 🚀`);
});

export default http(app);
