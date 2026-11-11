import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, Check, ChevronRight, Clock3, Download,
  FileText, LayoutDashboard, LoaderCircle, Play, RefreshCw, Shield, Workflow, X,
} from "lucide-react";
import { api, checkApiHealth } from "./api.js";

const SECTIONS = [
  ["dashboard", "Dashboard", LayoutDashboard],
  ["templates", "Templates", Workflow],
  ["monitor", "Execution Monitor", Activity],
  ["details", "Execution Details / Resilience Lab", Shield],
];
const SCENARIOS = [
  ["none", "No injected failure"],
  ["temporary_failure", "Temporary failure — succeeds on retry"],
  ["permanent_failure", "Permanent failure — exhausts retries"],
  ["slow_task", "Slow task — exceeds timeout"],
  ["independent_branch_failure", "Independent branch failure"],
];
const INITIAL_PARAMETERS = {
  scenario: "none",
  failureProbability: 0,
  maxAttempts: 3,
  taskTimeoutMs: 1000,
  artificialDelayMs: 0,
};

const statusClass = (status = "PENDING") => status.toLowerCase().replaceAll("_", "-");
const formatDate = (value) => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value))
  : "—";
const formatDuration = (start, end) => {
  if (!start) return "—";
  const milliseconds = Math.max(0, (end ? Date.parse(end) : Date.now()) - Date.parse(start));
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
};
const displayJson = (value) => JSON.stringify(value, null, 2);

function Status({ value }) {
  return <span className={`status-badge ${statusClass(value)}`}><i />{(value ?? "PENDING").replaceAll("_", " ")}</span>;
}

function DagDiagram({ nodes }) {
  const primary = [];
  const included = new Set();
  let current = nodes[0];
  while (current && !included.has(current.id)) {
    primary.push(current);
    included.add(current.id);
    current = nodes.find((node) => !included.has(node.id) && node.dependencies?.includes(current.id));
  }
  const branches = nodes.filter((node) => !included.has(node.id));
  const lanes = [
    primary,
    ...branches.map((node) => [
      nodes.find((candidate) => candidate.id === node.dependencies?.[0]),
      node,
    ].filter(Boolean)),
  ];
  return (
    <div className="simple-dag" aria-label="Predefined workflow graph">
      {lanes.map((lane, laneIndex) => <div className="dag-lane" key={`lane-${laneIndex}`}>
        {lane.map((node, index) => <div className="dag-item" key={`${laneIndex}-${node.id}`}>
          <div className="dag-node"><span>{String(nodes.indexOf(node) + 1).padStart(2, "0")}</span><b>{node.name}</b></div>
          {index < lane.length - 1 && <ArrowRight className="dag-arrow" size={16} aria-hidden="true" />}
        </div>)}
      </div>)}
    </div>
  );
}

function Stat({ label, value, icon: Icon, tone }) {
  return <article className="stat-card"><div className={`stat-icon ${tone}`}><Icon size={18} /></div><div className="stat-label">{label}</div><div className="stat-value">{value ?? 0}</div></article>;
}

export default function App() {
  const [section, setSection] = useState("dashboard");
  const [templates, setTemplates] = useState([]);
  const [stats, setStats] = useState(null);
  const [executions, setExecutions] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [selectedExecutionId, setSelectedExecutionId] = useState("");
  const [executionDetail, setExecutionDetail] = useState(null);
  const [executionLogs, setExecutionLogs] = useState([]);
  const [parameters, setParameters] = useState(INITIAL_PARAMETERS);
  const [csvInput, setCsvInput] = useState(null);
  const [textInput, setTextInput] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [apiStatus, setApiStatus] = useState("checking");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);
  const selectedExecution = executions.find((execution) => execution.id === selectedExecutionId);
  const selectedTask = executionDetail?.tasks?.find((task) => task.taskId === selectedTaskId);
  const hasRunningExecutions = executions.some((execution) => execution.status === "RUNNING");

  const refresh = useCallback(async () => {
    try {
      await checkApiHealth();
      const [templateRows, dashboardStats, executionRows] = await Promise.all([
        api.get("/api/templates"),
        api.get("/api/dashboard/stats"),
        api.get("/api/executions?limit=50"),
      ]);
      setTemplates(templateRows);
      setStats(dashboardStats);
      setExecutions(executionRows);
      setApiStatus("connected");
    } catch (cause) {
      setApiStatus("disconnected");
      throw cause;
    }
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        await refresh();
        if (active) setError("");
      } catch (cause) {
        if (active) setError(`Backend API unavailable: ${cause.message}`);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, hasRunningExecutions ? 1500 : 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh, hasRunningExecutions]);

  useEffect(() => {
    if (!selectedExecutionId) {
      setExecutionDetail(null);
      setExecutionLogs([]);
      return undefined;
    }
    let active = true;
    const load = async () => {
      try {
        const [detail, taskRows, logs] = await Promise.all([
          api.get(`/api/executions/${encodeURIComponent(selectedExecutionId)}`),
          api.get(`/api/executions/${encodeURIComponent(selectedExecutionId)}/tasks`),
          api.get(`/api/executions/${encodeURIComponent(selectedExecutionId)}/logs`),
        ]);
        if (active) {
          setExecutionDetail({ ...detail, tasks: taskRows });
          setExecutionLogs(logs);
          setSelectedTaskId((current) => current ||
            (detail.workflowId.startsWith("text-analysis:") ? "text-report" : taskRows[0]?.taskId || ""));
        }
      } catch (cause) {
        if (active) setError(cause.message);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 1200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedExecutionId]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const startExecution = async () => {
    if (!selectedTemplate) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.post("/api/executions", {
        templateId: selectedTemplate.id,
        ...(selectedTemplate.id === "resilience-recovery" ? { parameters } : {}),
        ...(selectedTemplate.id === "csv-processing" && csvInput
          ? { input: { csvContent: csvInput.content } }
          : {}),
        ...(selectedTemplate.id === "text-analysis" ? { input: { text: textInput } } : {}),
      });
      setSelectedExecutionId(result.executionId);
      setSelectedTaskId("");
      setSection("monitor");
      await refresh();
      setToast("Execution started");
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  const selectTemplate = (template) => {
    setSelectedTemplateId(template.id);
    setParameters(INITIAL_PARAMETERS);
    setCsvInput(null);
    setTextInput("");
    setSection("details");
  };

  const selectCsvFile = async (file) => {
    if (!file) return;
    setError("");
    setCsvInput(null);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Choose a .csv file.");
      return;
    }
    if (file.size === 0) {
      setError("The selected CSV file is empty.");
      return;
    }
    if (file.size > 512 * 1024) {
      setError("CSV uploads must be 512 KB or smaller.");
      return;
    }
    try {
      setCsvInput({ name: file.name, content: await file.text() });
    } catch (cause) {
      setError(`Could not read the selected CSV file: ${cause.message}`);
    }
  };

  const openExecution = (execution) => {
    setSelectedExecutionId(execution.id);
    setSelectedTaskId("");
    const templateId = execution.workflowId.split(":")[0];
    if (templates.some((template) => template.id === templateId)) setSelectedTemplateId(templateId);
    setSection("monitor");
  };

  const pageName = SECTIONS.find(([id]) => id === section)?.[1] ?? "Dashboard";
  const templateNodes = useMemo(() => selectedTemplate?.nodes ?? [], [selectedTemplate]);
  const exportUrl = selectedExecution?.status === "SUCCESS" &&
    selectedExecution?.workflowId?.startsWith("csv-processing:")
    ? `/api/executions/${encodeURIComponent(selectedExecution.id)}/output`
    : undefined;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Workflow size={19} /></div><div><strong>orbit<span>.</span></strong><small>RESILIENT ORCHESTRATOR</small></div></div>
        <div className="workspace-switch"><span className="workspace-dot" /> Local workspace</div>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="main-nav">
          {SECTIONS.map(([id, label, Icon]) => <button key={id} className={`nav-item ${section === id ? "active" : ""}`} onClick={() => setSection(id)}><Icon size={16} /><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-bottom"><div className={`connection-indicator api-${apiStatus}`}><i className="live-dot" />API {apiStatus}</div><div className="sidebar-version">ORBIT ENGINE <span>v1.0</span></div></div>
      </aside>

      <main className="main-area">
        <header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>{pageName}</strong></div><div className="topbar-actions"><span className="topbar-clock"><i className="live-dot" />Live updates</span><button className="icon-button" aria-label="Refresh data" onClick={() => refresh().catch((cause) => setError(cause.message))}><RefreshCw size={17} /></button></div></header>
        <div className="page-content">
          {error && <div className="alert-banner"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div>}
          {loading ? <div className="loading-screen"><LoaderCircle className="spin" size={25} /><span>Connecting to orchestrator…</span></div> : <>
            {section === "dashboard" && <Dashboard stats={stats} executions={executions} templates={templates} onTemplate={selectTemplate} onExecution={openExecution} onTemplates={() => setSection("templates")} />}
            {section === "templates" && <Templates templates={templates} onSelect={selectTemplate} />}
            {section === "monitor" && <Monitor executions={executions} selectedId={selectedExecutionId} onSelect={openExecution} detail={executionDetail} logs={executionLogs} selectedTaskId={selectedTaskId} onTask={setSelectedTaskId} onDetails={() => setSection("details")} exportUrl={exportUrl} />}
            {section === "details" && <Details template={selectedTemplate} parameters={parameters} onParameters={setParameters} csvInput={csvInput} onCsvFile={selectCsvFile} onUseSample={() => setCsvInput(null)} textInput={textInput} onTextInput={setTextInput} onRun={startExecution} busy={busy} onSelectTemplate={selectTemplate} templates={templates} execution={executionDetail} logs={executionLogs} selectedTask={selectedTask} onTask={setSelectedTaskId} exportUrl={exportUrl} />}
          </>}
        </div>
      </main>
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  );
}

function Dashboard({ stats, executions, templates, onTemplate, onExecution, onTemplates }) {
  return <section className="page-stack">
    <div className="page-heading heading-row"><div><div className="eyebrow"><LayoutDashboard size={13} /> YOUR WORKSPACE</div><h1>Orchestration dashboard.</h1><p>Choose a predefined pipeline, configure it, and inspect its execution.</p></div><button className="button button-primary" onClick={onTemplates}>Browse templates <ArrowRight size={15} /></button></div>
    <div className="stat-grid">
      <Stat label="Total executions" value={stats?.totalExecutions} icon={Activity} tone="violet" />
      <Stat label="Successful" value={stats?.successfulExecutions} icon={Check} tone="green" />
      <Stat label="Failed" value={stats?.failedExecutions} icon={AlertTriangle} tone="orange" />
      <Stat label="Currently running" value={stats?.runningExecutions} icon={Clock3} tone="blue" />
    </div>
    <section className="panel template-panel"><div className="panel-heading"><div><h2>Available templates</h2><p>Three backend-defined workflows; graph structure is fixed.</p></div></div><TemplateCards templates={templates} onSelect={onTemplate} /></section>
    <section className="panel recent-panel"><div className="panel-heading"><div><h2>Recent executions</h2><p>Live status from the orchestrator database</p></div></div><ExecutionRows executions={executions.slice(0, 10)} onSelect={onExecution} /></section>
  </section>;
}

function Templates({ templates, onSelect }) {
  return <section className="page-stack"><div className="page-heading"><div><div className="eyebrow"><Workflow size={13} /> PREDEFINED PIPELINES</div><h1>Workflow templates.</h1><p>Select a fixed DAG and configure its supported parameters.</p></div></div><TemplateCards templates={templates} onSelect={onSelect} /></section>;
}

function TemplateCards({ templates, onSelect }) {
  if (templates.length === 0) return <div className="inline-empty">No workflow templates are available from the API.</div>;
  return <div className="template-grid">{templates.map((template) => <article className="panel template-card" key={template.id}>
    <div className="template-card-heading"><div className="stat-icon violet"><Workflow size={17} /></div><div><h2>{template.name}</h2><p>{template.description}</p></div></div>
    <DagDiagram nodes={template.nodes} />
    <button className="button button-primary" onClick={() => onSelect(template)}>Select and Configure <ArrowRight size={14} /></button>
  </article>)}</div>;
}

function ExecutionRows({ executions, onSelect }) {
  if (executions.length === 0) return <div className="inline-empty"><FileText size={17} /> No executions yet. Choose a template to start.</div>;
  return <div className="execution-table"><div className="table-head"><span>WORKFLOW</span><span>STATUS</span><span>STARTED</span><span>DURATION</span></div>
    {executions.map((execution) => <button className="execution-row" key={execution.id} onClick={() => onSelect(execution)}>
      <span className="execution-name"><span className="row-icon"><Workflow size={15} /></span><span><b>{execution.workflowName}</b><small>{execution.id.slice(0, 8)}</small></span></span>
      <span><Status value={execution.status} /></span><span className="muted">{formatDate(execution.startedAt)}</span><span className="muted">{formatDuration(execution.startedAt, execution.endedAt)}</span>
    </button>)}
  </div>;
}

function Details({ template, templates, parameters, onParameters, csvInput, onCsvFile, onUseSample, textInput, onTextInput, onRun, busy, onSelectTemplate, execution, logs, selectedTask, onTask, exportUrl }) {
  const update = (key, value) => onParameters((current) => ({ ...current, [key]: value }));
  return <section className="page-stack">
    <div className="page-heading"><div><div className="eyebrow"><Shield size={13} /> TEMPLATE CONFIGURATION</div><h1>Execution details & resilience lab.</h1><p>Configure a predefined workflow or inspect an execution and its task outputs.</p></div></div>
    {!template ? <section className="panel template-picker"><h2>Select a template</h2><TemplateCards templates={templates} onSelect={onSelectTemplate} /></section> : <>
      <section className="panel template-config"><div className="panel-heading"><div><h2>{template.name}</h2><p>{template.description}</p></div></div><DagDiagram nodes={template.nodes} />
        {template.id === "resilience-recovery" && <div className="parameter-grid">
          <label className="field"><span>Failure scenario</span><select value={parameters.scenario} onChange={(event) => update("scenario", event.target.value)}>{SCENARIOS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="field"><span>Failure probability · {Math.round(parameters.failureProbability * 100)}%</span><input type="range" min="0" max="1" step="0.05" value={parameters.failureProbability} onChange={(event) => update("failureProbability", Number(event.target.value))} /></label>
          <label className="field"><span>Maximum attempts</span><input type="number" min="1" max="21" value={parameters.maxAttempts} onChange={(event) => update("maxAttempts", Math.min(21, Math.max(1, Number(event.target.value))))} /></label>
          <label className="field"><span>Task timeout (ms) · 0 = none</span><input type="number" min="0" max="2147483647" value={parameters.taskTimeoutMs} onChange={(event) => update("taskTimeoutMs", Math.min(2147483647, Math.max(0, Number(event.target.value))))} /></label>
          <label className="field"><span>Artificial task delay (ms)</span><input type="number" min="0" max="2147483647" value={parameters.artificialDelayMs} onChange={(event) => update("artificialDelayMs", Math.min(2147483647, Math.max(0, Number(event.target.value))))} /></label>
        </div>}
        {template.id === "csv-processing" && <div className="input-panel">
          <label className="field"><span>CSV input file</span><input type="file" accept=".csv,text/csv" onChange={(event) => onCsvFile(event.target.files?.[0])} /></label>
          <p className="template-note">{csvInput ? `Selected: ${csvInput.name}` : "No file selected; the included sample CSV will be used."} Upload a CSV up to 512 KB. Validation findings and cleaning statistics appear in task outputs.</p>
          {csvInput && <button className="button button-secondary" type="button" onClick={onUseSample}>Use included sample instead</button>}
        </div>}
        {template.id === "text-analysis" && <label className="field text-input-field"><span>Text to analyze</span><textarea rows="8" maxLength={100000} value={textInput} onChange={(event) => onTextInput(event.target.value)} placeholder="Paste or type text to analyze…" /><small>{textInput.length.toLocaleString()} / 100,000 characters</small></label>}
        <button className="button button-primary" onClick={onRun} disabled={busy || (parameters.scenario === "slow_task" && parameters.taskTimeoutMs === 0) || (template.id === "text-analysis" && textInput.trim().length === 0)}><Play size={15} />{busy ? "Starting…" : "Execute pipeline"}</button>
      </section>
    </>}
    {execution && <ExecutionDetail execution={execution} logs={logs} selectedTask={selectedTask} onTask={onTask} exportUrl={exportUrl} />}
  </section>;
}

function Monitor({ executions, selectedId, onSelect, detail, logs, selectedTaskId, onTask, onDetails, exportUrl }) {
  const selectedTask = detail?.tasks?.find((task) => task.taskId === selectedTaskId);
  return <section className="page-stack">
    <div className="page-heading"><div><div className="eyebrow"><Activity size={13} /> LIVE OPERATIONS</div><h1>Execution monitor.</h1><p>Inspect task status, attempts, outputs, and structured execution logs.</p></div>{detail?.status === "RUNNING" && <span className="polling-note"><i className="live-dot" /> Polling every 1.2 seconds</span>}</div>
    <div className="monitor-layout"><section className="panel execution-history"><div className="panel-heading"><div><h2>Execution history</h2><p>{executions.length} recent runs</p></div></div><ExecutionRows executions={executions} onSelect={onSelect} /></section>
      {detail ? <ExecutionDetail execution={detail} logs={logs} selectedTask={selectedTask} onTask={onTask} exportUrl={exportUrl} onDetails={onDetails} /> : <section className="panel monitor-empty"><FileText size={22} /><h2>Select an execution</h2><p>Choose a run from history to inspect tasks and logs.</p></section>}
    </div>
  </section>;
}

function ExecutionDetail({ execution, logs, selectedTask, onTask, exportUrl, onDetails }) {
  const report = selectedTask?.taskId === "text-report" ? selectedTask.output : null;
  return <section className="panel execution-detail">
    <div className="panel-heading"><div><div className="eyebrow">EXECUTION · {execution.id.slice(0, 12)}</div><h2>{execution.workflowName}</h2><p>Started {formatDate(execution.startedAt)} · Duration {formatDuration(execution.startedAt, execution.endedAt)}</p></div><Status value={execution.status} /></div>
    {exportUrl && <a className="button button-secondary download-button" href={exportUrl}><Download size={15} /> Download processed CSV</a>}
    {onDetails && <button className="text-button" onClick={onDetails}>Open details & resilience lab <ArrowRight size={14} /></button>}
    <div className="task-run-list"><h3>Tasks</h3>{execution.tasks.map((task) => <button className={`task-run ${selectedTask?.taskId === task.taskId ? "task-run-selected" : ""}`} key={task.taskId} onClick={() => onTask(task.taskId)}>
      <span className="task-run-title"><b>{task.taskId}</b><Status value={task.status} /></span><small>{task.attempts} attempt{task.attempts === 1 ? "" : "s"} · {formatDuration(task.startedAt, task.endedAt)}</small>
      {task.error && <span className="task-error">{task.error}</span>}
    </button>)}</div>
    {selectedTask && <div className="task-output"><h3>{report ? "Text analysis report" : "Task output"}</h3>{selectedTask.error && <p className="task-error">{selectedTask.error}</p>}{report?.statistics ? <TextReport report={report} /> : <pre>{displayJson(selectedTask.output ?? (selectedTask.error ? { error: selectedTask.error } : {}))}</pre>}</div>}
    <div className="attempt-log"><h3>Execution logs</h3>{logs.length === 0 ? <p className="muted">No logs recorded.</p> : <ol>{logs.map((log, index) => <li key={`${log.createdAt}-${index}`}><time>{formatDate(log.createdAt)}</time><span className={`log-level ${log.level.toLowerCase()}`}>{log.level}</span><span>{log.message}</span>{log.taskId && <small>{log.taskId}</small>}</li>)}</ol>}</div>
  </section>;
}

function TextReport({ report }) {
  const { statistics, validationIssues = [] } = report;
  const keywordFrequency = statistics.keywordFrequency?.length
    ? statistics.keywordFrequency
    : statistics.topTerms ?? [];
  const topics = report.topics?.length
    ? report.topics
    : keywordFrequency.slice(0, 5).map(({ word }) => word);
  const averageSentenceLength = Number.isFinite(statistics.averageSentenceLength)
    ? statistics.averageSentenceLength
    : statistics.sentences > 0
      ? Number((statistics.words / statistics.sentences).toFixed(1))
      : 0;
  const metrics = [
    ["Words", statistics.words],
    ["Sentences", statistics.sentences],
    ["Avg. words / sentence", averageSentenceLength],
    ["Paragraphs", statistics.paragraphs],
  ];
  return <div className="text-report">
    <p className="text-report-summary">{report.summary}</p>
    <div className="text-report-metrics">{metrics.map(([label, value]) => <div className="text-report-metric" key={label}><span>{label}</span><b>{value}</b></div>)}</div>
    <section><h4>Main topics</h4>{topics.length ? <div className="text-report-topics">{topics.map((topic) => <span key={topic}>{topic}</span>)}</div> : <p className="muted">No recurring keywords found.</p>}</section>
    <section><h4>Keyword frequency</h4>{keywordFrequency.length
      ? <ul className="text-report-keywords">{keywordFrequency.map(({ word, count }) => <li key={word}><span>{word}</span><b>{count}</b></li>)}</ul>
      : <p className="muted">No keywords found.</p>}</section>
    <section><h4>Validation</h4><p className={validationIssues.length ? "task-error" : "text-report-valid"}>{validationIssues.length ? validationIssues.join(" ") : "No validation issues found."}</p></section>
  </div>;
}
