import { createRequire } from "module";
import axios from "axios";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

const url =
  "https://apps.cbe.com.et:100/?id=FT261322F36X83440695";
const res = await axios.get(url, {
  responseType: "arraybuffer",
  headers: { "User-Agent": "Mozilla/5.0", Accept: "application/pdf" },
  timeout: 30000,
});
const buf = Buffer.from(res.data);
const data = await pdfParse(buf);
console.log("---TEXT START---");
console.log(data.text);
console.log("---TEXT END---");
