import fs from "fs";
import path from "path";

function walk(dir, callback) {
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);

    if (fs.statSync(fullPath).isDirectory()) {
      walk(fullPath, callback);
    } else if (file.endsWith(".js")) {
      callback(fullPath);
    }
  });
}

const replacements = [
  {
    from: "@/services/actions/",
    to: "@/services/AI/actions/"
  },
  {
    from: "../actions/",
    to: "./actions/"
  },
  {
    from: "../../actions/",
    to: "../actions/"
  },
  {
    from: "../../../core/",
    to: "../core/"
  },
  {
    from: "../../../knowledge/",
    to: "../knowledge/"
  }
];

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, "utf-8");

  let changed = false;

  for (const rule of replacements) {
    if (content.includes(rule.from)) {
      content = content.split(rule.from).join(rule.to);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, content);
    console.log("FIXED:", filePath);
  }
}

walk("./src", fixFile);

console.log("DONE: imports corrigidos");