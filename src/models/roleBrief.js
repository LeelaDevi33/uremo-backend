// Optional applicant-facing details. An empty field means the editor has
// not published an answer; it should never imply a location or qualification.
const choices = {
  experienceLevel: ["", "entry", "intermediate", "advanced"],
  workMode: ["", "remote", "hybrid", "onsite"],
};
const textLimits = { locationEligibility: 160, timeCommitment: 120 };
const listLimits = { skills: 64, responsibilities: 240 };
const maxItems = 12;

function validLine(value, limit) {
  return typeof value === "string" && !/[\r\n\u2028\u2029]/u.test(value) && value.trim().length <= limit;
}

function validList(values, limit) {
  if (!Array.isArray(values) || values.length > maxItems) return false;
  if (!values.every(value => validLine(value, limit) && value.trim())) return false;
  return new Set(values.map(value => value.trim().toLowerCase())).size === values.length;
}

module.exports = { choices, textLimits, listLimits, validLine, validList };
