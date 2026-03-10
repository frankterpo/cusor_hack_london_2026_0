async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

function flagChip(value) {
  const v = Number(value);
  if (v === 0 || value === false) return '<span class="flag ok">No</span>';
  return '<span class="flag danger">Yes</span>';
}

function hasAnyFlag(row) {
  return (
    Number(row.has_commits_before_t0) > 0 ||
    Number(row.has_bulk_commits) > 0 ||
    Number(row.has_large_initial_commit_after_t0) > 0 ||
    Number(row.has_merge_commits) > 0
  );
}

function formatNumber(num) {
  const n = Number(num) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function updateStats(rows) {
  const total = rows.length;
  const tracked = rows.filter((r) => r.submission_status !== 'missing').length;
  const analyzed = rows.filter((r) => r.analysis_status === 'analyzed').length;
  const flagged = rows.filter((r) => r.analysis_status === 'analyzed' && hasAnyFlag(r)).length;
  const clean = rows.filter((r) => r.analysis_status === 'analyzed' && !hasAnyFlag(r)).length;
  
  // Calculate total commits and LoC
  const totalCommits = rows.reduce((sum, r) => sum + (Number(r.total_commits) || 0), 0);
  const totalLocAdded = rows.reduce((sum, r) => sum + (Number(r.total_loc_added) || 0), 0);
  const totalLocDeleted = rows.reduce((sum, r) => sum + (Number(r.total_loc_deleted) || 0), 0);
  const totalLoc = totalLocAdded + totalLocDeleted;

  document.getElementById("stat-total").textContent = total;
  document.getElementById("stat-tracked").textContent = tracked;
  document.getElementById("stat-analyzed").textContent = analyzed;
  document.getElementById("stat-flagged").textContent = flagged;
  document.getElementById("stat-clean").textContent = clean;
  document.getElementById("stat-commits").textContent = formatNumber(totalCommits);
  document.getElementById("stat-loc").textContent = formatNumber(totalLoc);
}

function extractRepoName(repoUrl) {
  const match = repoUrl.match(/github\.com\/([^\/]+\/[^\/]+?)(?:\.git)?$/);
  if (match) return match[1];
  return repoUrl;
}

// Judge data cache
let judgeMap = new Map();
let submissionMap = new Map();

function normalizeRepoKey(repoUrl = "") {
  return repoUrl.trim().replace(/\.git$/i, "").toLowerCase();
}

function slugify(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function loadJudgeData() {
  try {
    const data = await fetchJSON("/api/judges");
    const map = new Map();
    if (data && data.by_repo) {
      for (const [repoUrl, info] of Object.entries(data.by_repo)) {
        const key = normalizeRepoKey(repoUrl);
        map.set(key, info);
        // Also store raw repoUrl as-is for exact matches
        map.set(normalizeRepoKey(repoUrl.replace(/\.git$/i, "")), info);
      }
    }
    judgeMap = map;
  } catch (err) {
    console.error("Failed to load judge data", err);
    judgeMap = new Map();
  }
}

async function loadSubmissionData() {
  try {
    const data = await fetchJSON("/api/submissions");
    const map = new Map();
    for (const submission of data.submissions || []) {
      if (submission.repo_url) {
        map.set(normalizeRepoKey(submission.repo_url), submission);
      }
      if (submission.submission_id) {
        map.set(`submission:${submission.submission_id}`, submission);
      }
    }
    submissionMap = map;
  } catch (err) {
    console.error("Failed to load submission data", err);
    submissionMap = new Map();
  }
}

// Cache for AI summaries
const aiCache = new Map();

async function fetchAISummary(repoId) {
  if (aiCache.has(repoId)) return aiCache.get(repoId);
  const text = await fetchText(`/api/repo/${repoId}/ai`);
  aiCache.set(repoId, text);
  return text;
}

function getAIPreview(aiText) {
  if (!aiText) return '<span class="ai-preview no-data">No AI analysis</span>';
  // Get first two sentences or first 150 chars
  const sentences = aiText.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
  const preview = sentences.length > 180 ? sentences.slice(0, 180) + '…' : sentences;
  return `<span class="ai-preview">${escapeHtml(preview)}</span>`;
}

function extractVerdict(aiText) {
  if (!aiText) return { icon: '⏳', class: 'pending', full: 'Pending analysis' };
  
  const verdictMatch = aiText.match(/Overall authenticity assessment:\s*(.+?)$/mi);
  if (!verdictMatch) return { icon: '⏳', class: 'pending', full: 'No assessment found' };
  
  const verdict = verdictMatch[1].trim();
  const isAuthentic = /consistent|authentic|legitimate/i.test(verdict);
  const isSuspicious = /suspicious|concern|flag|issue|question/i.test(verdict);
  
  if (isSuspicious) {
    return { icon: '⚠️', class: 'suspicious', full: verdict };
  } else if (isAuthentic) {
    return { icon: '✅', class: 'authentic', full: verdict };
  }
  return { icon: '➖', class: 'neutral', full: verdict };
}

function getVerdictBadge(aiText) {
  const verdict = extractVerdict(aiText);
  return `<span class="verdict-icon ${verdict.class}" title="${escapeHtml(verdict.full)}">${verdict.icon}</span>`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return (text || "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function humanizeKey(text) {
  return String(text || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getJudgeInfoForRow(row) {
  if (!row) return null;
  const key = normalizeRepoKey(row.repo || "");
  return judgeMap.get(key) || judgeMap.get(normalizeRepoKey(row.repo || "").replace(/\.git$/i, ""));
}

function getSubmissionInfoForRow(row) {
  if (!row) return null;
  const repoKey = normalizeRepoKey(row.repo || row.repo_url || "");
  if (repoKey && submissionMap.has(repoKey)) return submissionMap.get(repoKey);
  if (row.repo_id && submissionMap.has(`submission:${row.repo_id}`)) return submissionMap.get(`submission:${row.repo_id}`);
  return null;
}

function analysisStatusChip(row) {
  if (row.analysis_status === 'analyzed') return '<span class="status-chip status-chip--analyzed">Analyzed</span>';
  return '<span class="status-chip status-chip--pending">Submitted</span>';
}

function trackChip(track) {
  if (!track) return '<span class="track-chip track-chip--empty">Unassigned</span>';
  return `<span class="track-chip">${escapeHtml(track)}</span>`;
}

function demoLink(submission) {
  if (!submission || !submission.demo_url) return '';
  return `<a class="repo-link" href="${escapeAttr(submission.demo_url)}" target="_blank" rel="noreferrer">Demo</a>`;
}

function repoLink(url) {
  if (!url) return '';
  return `<a class="repo-link" href="${escapeAttr(url)}" target="_blank" rel="noreferrer">Repo</a>`;
}

function buildJudgeTooltip(info) {
  if (!info || !info.responses || info.responses.length === 0) return "No judge responses";
  const parts = info.responses.map((r, idx) => {
    const thought = r.notes ? ` — ${r.notes}` : (r.thoughts ? ` — ${r.thoughts}` : "");
    if (info.legacy_mode) {
      return `#${idx + 1}: ${r.total_score}${thought}`;
    }
    return `#${idx + 1}: ${r.total_score}/130 (core ${r.core_total}, bonus ${r.bonus_total_capped})${thought}`;
  });
  return parts.join("\n");
}

function renderJudgeCell(info) {
  if (!info || !info.responses || info.responses.length === 0) {
    return '<span class="judge-chip no-data">—</span>';
  }
  const avg = Number((info.averages && info.averages.grand_total) ?? info.average_score ?? 0).toFixed(1);
  const cap = info.legacy_mode ? '' : '<span class="judge-count">/130</span>';
  const tooltip = escapeAttr(buildJudgeTooltip(info));
  return `<span class="judge-chip" title="${tooltip}">${avg}${cap}<span class="judge-count"> · ${info.responses.length}</span></span>`;
}

function renderJudgeDetails(info) {
  const container = document.getElementById("judge-output");
  if (!info || !info.responses || info.responses.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🧑‍⚖️</div><div>No judge responses</div></div>';
    return;
  }
  const grandAvg = Number((info.averages && info.averages.grand_total) ?? info.average_score ?? 0).toFixed(1);
  const coreAvg = Number((info.averages && info.averages.core_total) ?? info.average_score ?? 0).toFixed(1);
  const bonusAvg = Number((info.averages && info.averages.bonus_total) ?? 0).toFixed(1);
  const criterionList = info.legacy_mode
    ? ''
    : Object.entries(info.averages.core_scores || {})
        .map(([key, value]) => `<div class="judge-row"><div class="judge-score-pill">${escapeHtml(humanizeKey(key))}</div><div class="judge-thought">${Number(value).toFixed(1)} avg</div></div>`)
        .join("");
  const bonusList = info.legacy_mode
    ? ''
    : Object.entries(info.averages.bonus_bucket_scores || {})
        .map(([key, value]) => `<div class="judge-row"><div class="judge-score-pill">${escapeHtml(humanizeKey(key))}</div><div class="judge-thought">${Number(value).toFixed(1)} avg</div></div>`)
        .join("");
  const list = info.responses
    .map((r, idx) => {
      const thought = r.thoughts ? `<div class="judge-thought">${escapeHtml(r.thoughts)}</div>` : "";
      const scoreLine = info.legacy_mode
        ? `#${idx + 1} • ${r.total_score}`
        : `#${idx + 1} • ${r.total_score}/130 (core ${r.core_total}, bonus ${r.bonus_total_capped})`;
      return `<div class="judge-row"><div class="judge-score-pill">${scoreLine}</div>${thought}</div>`;
    })
    .join("");
  container.innerHTML = `
    <div class="judge-summary">
      <div class="judge-score-pill highlight">${grandAvg}${info.legacy_mode ? '' : '/130'}</div>
      <div class="judge-meta">${info.responses.length} response${info.responses.length !== 1 ? 's' : ''}</div>
    </div>
    ${info.legacy_mode ? '' : `
      <div class="judge-summary">
        <div class="judge-score-pill">Core ${coreAvg}/100</div>
        <div class="judge-score-pill">Bonus ${bonusAvg}/30</div>
      </div>
      <div class="judge-list">${criterionList}</div>
      <div class="judge-list">${bonusList}</div>
    `}
    <div class="judge-list">${list}</div>
  `;
}

async function renderSummaryTable(rows) {
  const tbody = document.querySelector("#summary-table tbody");
  tbody.innerHTML = "";
  const filterPre = document.querySelector("#filter-preT0").checked;
  const filterBulk = document.querySelector("#filter-bulk").checked;
  const filterMerge = document.querySelector("#filter-merge").checked;
  const sortMode = document.querySelector("#sort-select").value;

  const filteredRows = rows.filter((r) => {
    if (filterPre && Number(r.has_commits_before_t0) === 0) return false;
    if (filterBulk && Number(r.has_bulk_commits) === 0) return false;
    if (filterMerge && Number(r.has_merge_commits) === 0) return false;
    return true;
  });

  const sortedRows = [...filteredRows].sort((a, b) => {
    if (sortMode === "judge") {
      const ja = getJudgeInfoForRow(a);
      const jb = getJudgeInfoForRow(b);
      const avga = ja ? Number((ja.averages && ja.averages.grand_total) ?? ja.average_score ?? -Infinity) : -Infinity;
      const avgb = jb ? Number((jb.averages && jb.averages.grand_total) ?? jb.average_score ?? -Infinity) : -Infinity;
      if (avga === avgb) return 0;
      return avgb - avga;
    }
    if (sortMode === "commits") {
      return Number(b.total_commits || 0) - Number(a.total_commits || 0);
    }
    return 0;
  });

  updateStats(rows);

  if (sortedRows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="13">
          <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <div>No submissions match the current filters</div>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  // Render rows first with loading placeholders for AI
  sortedRows.forEach((row) => {
    const tr = document.createElement("tr");
    const repoId = row.repo_id || row.submission_id || extractRepoName(row.repo);
    const submission = getSubmissionInfoForRow(row);
    const displayName = submission?.project_name || row.repo_id || extractRepoName(row.repo);
    const teamName = submission?.team_name || "";
    const judgeInfo = getJudgeInfoForRow(row);
    
    tr.innerHTML = `
      <td>
        <div class="repo-cell">
          <span class="repo-name">${escapeHtml(displayName)}</span>
          ${teamName ? `<span class="repo-meta">Team ${escapeHtml(teamName)}</span>` : ""}
          <span class="repo-url">${escapeHtml(row.repo || submission?.repo_url || "")}</span>
          <div class="repo-actions">${repoLink(row.repo || submission?.repo_url || "")}${demoLink(submission)}</div>
        </div>
      </td>
      <td>${trackChip(submission?.chosen_track || row.chosen_track || "")}</td>
      <td>${analysisStatusChip(row)}</td>
      <td><div class="judge-cell">${renderJudgeCell(judgeInfo)}</div></td>
      <td><span class="num-cell">${row.total_commits}</span></td>
      <td><span class="num-cell loc-add">+${formatNumber(row.total_loc_added)}</span></td>
      <td><span class="num-cell loc-del">−${formatNumber(row.total_loc_deleted)}</span></td>
      <td style="text-align:center">${flagChip(row.has_commits_before_t0)}</td>
      <td style="text-align:center">${flagChip(row.has_bulk_commits)}</td>
      <td style="text-align:center">${flagChip(row.has_large_initial_commit_after_t0)}</td>
      <td style="text-align:center">${flagChip(row.has_merge_commits)}</td>
      <td class="verdict-cell"><span class="verdict-icon pending">⏳</span></td>
      <td class="ai-cell"><span class="ai-preview no-data">Loading...</span></td>
    `;
    tr.dataset.repoId = repoId;
    tr.addEventListener("click", () => {
      document.querySelectorAll("#summary-table tbody tr").forEach((r) => r.classList.remove("selected"));
      tr.classList.add("selected");
      openDrawer(repoId);
    });
    tbody.appendChild(tr);

    // Fetch AI summary async
    fetchAISummary(repoId).then(aiText => {
      const aiCell = tr.querySelector('.ai-cell');
      const verdictCell = tr.querySelector('.verdict-cell');
      if (aiCell) aiCell.innerHTML = getAIPreview(aiText);
      if (verdictCell) verdictCell.innerHTML = getVerdictBadge(aiText);
    });
  });
}

async function loadSummary() {
  const [summaryData] = await Promise.all([
    fetchJSON("/api/summary").catch(() => ({ rows: [] })),
    loadJudgeData(),
    loadSubmissionData(),
  ]);
  const summaryRows = summaryData.rows || [];
  const merged = mergeRows(summaryRows, Array.from(submissionMap.values()).filter((value, index, array) => {
    return array.findIndex((candidate) => candidate.submission_id === value.submission_id) === index;
  }));
  window.__summaryRows = merged;
  await renderSummaryTable(window.__summaryRows);
}

function mergeRows(summaryRows, submissions) {
  const byRepo = new Map();

  summaryRows.forEach((row) => {
    const repoKey = normalizeRepoKey(row.repo || "");
    byRepo.set(repoKey, {
      ...row,
      repo_id: row.repo_id || extractRepoName(row.repo),
      submission_status: submissionMap.has(repoKey) ? 'submitted' : 'missing',
      analysis_status: 'analyzed',
    });
  });

  submissions.forEach((submission) => {
    const repoKey = normalizeRepoKey(submission.repo_url || "");
    if (byRepo.has(repoKey)) {
      byRepo.set(repoKey, {
        ...byRepo.get(repoKey),
        ...submission,
        submission_status: 'submitted',
      });
      return;
    }

    byRepo.set(repoKey, {
      repo_id: submission.submission_id,
      repo: submission.repo_url,
      repo_url: submission.repo_url,
      submission_id: submission.submission_id,
      project_name: submission.project_name,
      team_name: submission.team_name,
      chosen_track: submission.chosen_track,
      demo_url: submission.demo_url,
      submission_status: 'submitted',
      analysis_status: 'pending',
      total_commits: 0,
      total_loc_added: 0,
      total_loc_deleted: 0,
      has_commits_before_t0: 0,
      has_bulk_commits: 0,
      has_large_initial_commit_after_t0: 0,
      has_merge_commits: 0,
    });
  });

  return Array.from(byRepo.values());
}

function formatJSON(obj) {
  return JSON.stringify(obj, null, 2);
}

// Drawer functionality
function openDrawer(repoId) {
  const drawer = document.getElementById("details-drawer");
  const overlay = document.getElementById("drawer-overlay");
  
  drawer.classList.remove("hidden");
  overlay.classList.remove("hidden");
  
  // Trigger reflow for animation
  drawer.offsetHeight;
  
  drawer.classList.add("visible");
  overlay.classList.add("visible");
  
  loadDetails(repoId);
}

function closeDrawer() {
  const drawer = document.getElementById("details-drawer");
  const overlay = document.getElementById("drawer-overlay");
  
  drawer.classList.remove("visible");
  overlay.classList.remove("visible");
  
  setTimeout(() => {
    drawer.classList.add("hidden");
    overlay.classList.add("hidden");
  }, 250);
  
  document.querySelectorAll("#summary-table tbody tr").forEach((r) => r.classList.remove("selected"));
}

async function loadDetails(repoId) {
  document.getElementById("detail-title").textContent = repoId;
  
  const submissionEl = document.getElementById("submission-output");
  const summaryEl = document.getElementById("metrics-summary");
  const flagsEl = document.getElementById("metrics-flags");
  const timeEl = document.getElementById("metrics-time");
  const aiEl = document.getElementById("ai-output");
  const judgeEl = document.getElementById("judge-output");
  
  submissionEl.textContent = "Loading...";
  summaryEl.textContent = "Loading...";
  flagsEl.textContent = "Loading...";
  timeEl.textContent = "Loading...";
  aiEl.textContent = "Loading...";
  judgeEl.textContent = "Loading...";
  
  try {
    const summaryRow = (window.__summaryRows || []).find(
      (r) => (r.repo_id || extractRepoName(r.repo)) === repoId
    );
    renderSubmissionDetails(summaryRow);
    const [metrics, aiText, commitsData] = await Promise.all([
      fetchJSON(`/api/repo/${repoId}/metrics`),
      fetchText(`/api/repo/${repoId}/ai`),
      fetchJSON(`/api/repo/${repoId}/commits`).catch(() => ({ rows: [] })),
    ]);
    
    summaryEl.textContent = formatJSON(metrics.summary || {});
    flagsEl.textContent = formatJSON(metrics.flags || {});
    timeEl.textContent = formatJSON(metrics.time_distribution || {});
    
    // Format AI output with verdict highlighting
    if (aiText) {
      const formattedAI = formatAIOutput(aiText);
      aiEl.innerHTML = formattedAI;
    } else {
      aiEl.textContent = "No AI analysis available for this submission.";
    }
    
    const judgeInfo = getJudgeInfoForRow(summaryRow);
    renderJudgeDetails(judgeInfo);

    renderCommits(commitsData.rows || []);
  } catch (err) {
    const summaryRow = (window.__summaryRows || []).find(
      (r) => (r.repo_id || extractRepoName(r.repo)) === repoId
    );
    renderSubmissionDetails(summaryRow);
    summaryEl.textContent = rowHasAnalysis(summaryRow) ? `Error: ${err.message}` : "Analysis not generated yet.";
    flagsEl.textContent = rowHasAnalysis(summaryRow) ? "" : "Run scan.py to populate commit metrics and authenticity flags.";
    timeEl.textContent = "";
    aiEl.textContent = rowHasAnalysis(summaryRow) ? "" : "AI analysis appears after repo analysis has been run.";
    const judgeInfo = getJudgeInfoForRow(summaryRow);
    renderJudgeDetails(judgeInfo);
    renderCommits([]);
  }
}

function rowHasAnalysis(row) {
  return row && row.analysis_status === 'analyzed';
}

function renderSubmissionDetails(row) {
  const container = document.getElementById("submission-output");
  const submission = getSubmissionInfoForRow(row) || row;
  if (!submission) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📨</div><div>No submission metadata</div></div>';
    return;
  }
  const items = [
    ["Project", submission.project_name || row?.repo_id || "—"],
    ["Team", submission.team_name || "—"],
    ["Track", submission.chosen_track || "—"],
    ["Submitted", submission.timestamp || "—"],
    ["Repo", submission.repo_url || row?.repo || "—"],
    ["Demo", submission.demo_url || "—"],
  ];
  container.innerHTML = `
    <div class="submission-grid">
      ${items.map(([label, value]) => `<div class="submission-item"><div class="submission-label">${escapeHtml(label)}</div><div class="submission-value">${escapeHtml(value)}</div></div>`).join("")}
    </div>
  `;
}

function formatAIOutput(text) {
  // Convert bullet points and highlight the verdict
  let html = escapeHtml(text);
  
  // Look for authenticity assessment line
  const verdictMatch = html.match(/(Overall authenticity assessment:.*?)$/mi);
  if (verdictMatch) {
    const verdict = verdictMatch[1];
    const isSuspicious = /suspicious|concern|flag|issue|question/i.test(verdict);
    const isAuthentic = /consistent|authentic|legitimate/i.test(verdict);
    // Suspicious takes priority over authentic keywords
    const verdictClass = isSuspicious ? 'suspicious' : (isAuthentic ? 'authentic' : 'suspicious');
    html = html.replace(verdict, `<span class="verdict ${verdictClass}">${verdict}</span>`);
  }
  
  return html;
}

function renderCommits(rows) {
  const tbody = document.querySelector("#commits-table tbody");
  const countEl = document.querySelector(".commit-count");
  tbody.innerHTML = "";
  
  countEl.textContent = `(${rows.length})`;
  
  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; color: var(--muted); padding: 20px;">
          No commits data available
        </td>
      </tr>
    `;
    return;
  }
  
  rows.slice(0, 100).forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="num-cell">${row.seq_index}</span></td>
      <td style="font-size: 0.7rem; color: var(--muted); white-space: nowrap;">${row.author_time_iso}</td>
      <td><span class="num-cell loc-add">+${row.insertions}</span></td>
      <td><span class="num-cell loc-del">−${row.deletions}</span></td>
      <td><span class="num-cell">${row.files_changed}</span></td>
      <td style="text-align:center">${flagChip(row.flag_bulk_commit)}</td>
      <td style="text-align:center">${flagChip(row.is_before_t0)}</td>
      <td style="text-align:center">${flagChip(row.is_after_t1)}</td>
      <td style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(row.subject)}">${escapeHtml(row.subject)}</td>
    `;
    tbody.appendChild(tr);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // Filter handlers
  ["filter-preT0", "filter-bulk", "filter-merge"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      renderSummaryTable(window.__summaryRows || []);
    });
  });
  document.getElementById("sort-select").addEventListener("change", () => {
    renderSummaryTable(window.__summaryRows || []);
  });
  
  // Drawer close handlers
  document.getElementById("close-drawer").addEventListener("click", closeDrawer);
  document.getElementById("drawer-overlay").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
  
  // Load data
  loadSummary().catch((err) => {
    const tbody = document.querySelector("#summary-table tbody");
    tbody.innerHTML = `
      <tr>
        <td colspan="13">
          <div class="empty-state">
            <div class="empty-state-icon">⚠️</div>
            <div>Failed to load data: ${err.message}</div>
          </div>
        </td>
      </tr>
    `;
  });
});
