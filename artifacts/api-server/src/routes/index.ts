import { Router, type IRouter } from "express";
import healthRouter from "./health";
import driveRouter from "./drive";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/drive", driveRouter);

export default router;
