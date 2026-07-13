import { apiGet } from "../api.js";

export async function initAboutPage() {
  const versionValue = document.getElementById("aboutVersionValue");
  if (!versionValue) {
    return;
  }

  try {
    const payload = await apiGet("/api/system/version");
    const version = payload.version || {};
    setText("aboutVersionName", formatName(version.name));
    setText("aboutVersionValue", formatVersion(version.version));
    setText("aboutVersionChannel", formatValue(version.channel));
    setText("aboutVersionBuild", formatBuild(version));
  } catch {
    setText("aboutVersionValue", "读取失败");
    setText("aboutVersionChannel", "--");
    setText("aboutVersionBuild", "--");
  }
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

function formatName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.toLowerCase() !== "tms" ? name : "CineTMS";
}

function formatVersion(value) {
  const version = typeof value === "string" ? value.trim() : "";
  return version ? `${version.replace(/^v/i, "")}` : "--";
}

function formatValue(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "--";
}

function formatBuild(version) {
  const commit = typeof version.commit === "string" ? version.commit.trim() : "";
  const buildTime = typeof version.buildTime === "string" ? version.buildTime.trim() : "";
  if (commit && buildTime) {
    return `${buildTime} · ${commit}`;
  }
  return buildTime || (commit ? `commit ${commit}` : "--");
}
