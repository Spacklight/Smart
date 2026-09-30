import dotenv from 'dotenv';
import { createApp } from './app.js';
dotenv.config();
const PORT = process.env.PORT || 3000;
const env = {
  HF_TOKEN: process.env.HF_TOKEN || '',
  HF_DATASET: process.env.HF_DATASET || '',
  JWT_SECRET: process.env.JWT_SECRET || process.env.SESSION_SECRET || '',
  SESSION_SECRET: process.env.SESSION_SECRET || process.env.JWT_SECRET || '',
  NODE_ENV: process.env.NODE_ENV || 'development'
};
const app = await createApp(env);
app.listen(PORT, () => console.log(`Smartbase local on ${PORT}`));
