import { useCallback, useEffect, useRef, useState } from "react";
import { PAPER_SCENARIOS, type PaperRun, type PaperScenarioId, type PaperStage } from "@rpm/shared";
import { formatMoney, formatPercent, parsePaperState, stageResult, statusTone } from "./presentation";

const STAGES: PaperStage[] = ["DATA", "RISK", "PROPOSAL", "CONSENSUS", "CONSTRAINTS", "EXECUTION", "RECONCILIATION"];
const STAGE_LABELS: Record<PaperStage, string> = {
  DATA: "Data quality", RISK: "Risk analysis", PROPOSAL: "Proposal", CONSENSUS: "Consensus",
  CONSTRAINTS: "Constraints", EXECUTION: "Paper execution", RECONCILIATION: "Reconciliation",
};

function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge badge--${statusTone(value)}`}>{label ?? value.replaceAll("_", " ")}</span>;
}

function Metric({ label, before, after, note }: { label: string; before: string; after: string; note: string }) {
  return <div className="metric">
    <div className="eyebrow">{label}</div>
    <div className="metric-values"><span>{before}</span><span className="metric-arrow" aria-label="to">→</span><strong>{after}</strong></div>
    <div className="muted small">{note}</div>
  </div>;
}

function RunResults({ run }: { run: PaperRun }) {
  const validPrices = run.dataQuality === "VALID";
  const assetIds = [...new Set([...Object.keys(run.before.units), ...Object.keys(run.after.units)])];
  const scenario = PAPER_SCENARIOS.find((item) => item.id === run.scenario);
  const constraints = stageResult(run, "CONSTRAINTS");
  const execution = stageResult(run, "EXECUTION");
  const reconciled = run.audit.some((event) => event.stage === "RECONCILIATION");
  return <div className="results" key={run.runId}>
    <section className={`outcome outcome--${statusTone(run.status)}`} aria-labelledby="outcome-heading">
      <div className="outcome-main">
        <div className="eyebrow">Final outcome <span className="separator">/</span> {scenario?.title ?? run.scenario}</div>
        <h2 id="outcome-heading">{run.status.replaceAll("_", " ")}</h2>
        <ul className="reasons">{run.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
      </div>
      <dl className="run-stamp">
        <div><dt>Replay ID</dt><dd>{run.runId}</dd></div>
        <div><dt>Fixture as of</dt><dd>{new Date(run.asOf).toISOString().replace("T", " ").replace(".000Z", " UTC")}</dd></div>
        <div><dt>Data quality</dt><dd><Badge value={run.dataQuality} /></dd></div>
      </dl>
    </section>

    <ol className="stage-strip" aria-label="Replay stages">
      {STAGES.map((stage, index) => {
        const result = stageResult(run, stage);
        return <li key={stage} className={`stage stage--${statusTone(result)}`}>
          <span className="stage-number">0{index + 1}</span>
          <strong>{STAGE_LABELS[stage]}</strong>
          <span>{result.replaceAll("_", " ")}</span>
        </li>;
      })}
    </ol>

    <section className="panel portfolio-panel" aria-labelledby="portfolio-heading">
      <div className="section-heading"><div><div className="eyebrow">01 / Portfolio</div><h2 id="portfolio-heading">The ledger, before & after</h2></div><span className="caption">USD · synthetic fixture</span></div>
      <div className="balance-metrics">
        <Metric label="Portfolio equity" before={formatMoney(run.equityBeforeCents)} after={formatMoney(run.equityAfterCents)} note="Marked at fixture prices; costs included." />
        <Metric label="Cash balance" before={formatMoney(run.before.cashCents)} after={formatMoney(run.after.cashCents)} note="Integer-cent ledger, after fees." />
      </div>
      <div className="table-scroll" role="region" aria-label="Portfolio positions" tabIndex={0}>
        <table className="positions-table">
          <thead><tr><th scope="col">Asset</th><th scope="col">Fixture price</th><th scope="col">Units before</th><th scope="col">Units after</th><th scope="col">Value after</th></tr></thead>
          <tbody>{assetIds.map((assetId) => {
            const price = validPrices ? run.pricesCents[assetId] : undefined;
            const afterUnits = run.after.units[assetId] ?? 0;
            return <tr key={assetId}>
              <th scope="row"><span>{run.assetNames[assetId] ?? assetId}</span><code>{assetId}</code></th>
              <td>{formatMoney(price)}</td><td>{(run.before.units[assetId] ?? 0).toLocaleString("en-US")}</td>
              <td className={afterUnits !== run.before.units[assetId] ? "changed" : ""}>{afterUnits.toLocaleString("en-US")}</td>
              <td>{formatMoney(price == null ? null : price * afterUnits)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </section>

    <section className="panel risk-panel" aria-labelledby="risk-heading">
      <div className="section-heading"><div><div className="eyebrow">02 / Risk</div><h2 id="risk-heading">Measure the change</h2></div><Badge value={run.riskAfter ? "SYNTHETIC" : "UNKNOWN"} /></div>
      <p className="section-note">Historical simulation on fixed synthetic returns. These are scenario diagnostics, not a forecast or validated investment model.</p>
      <div className="risk-metrics">
        <Metric label="Largest position" before={formatPercent(run.riskBefore?.concentration, true)} after={formatPercent(run.riskAfter?.concentration, true)} note="Concentration as a share of portfolio equity." />
        <Metric label="Historical VaR · 95%" before={formatPercent(run.riskBefore?.historicalVar95Pct)} after={formatPercent(run.riskAfter?.historicalVar95Pct)} note="One-day loss at the 95th percentile." />
        <Metric label="Expected shortfall · 95%" before={formatPercent(run.riskBefore?.historicalEs95Pct)} after={formatPercent(run.riskAfter?.historicalEs95Pct)} note="Mean loss at or above the VaR threshold." />
        <Metric label="Maximum drawdown" before={formatPercent(run.riskBefore?.maxDrawdownPct)} after={formatPercent(run.riskAfter?.maxDrawdownPct)} note={run.riskAfter ? `${run.riskAfter.samples} synthetic daily observations.` : "Risk is unknown when source data is invalid."} />
      </div>
      {run.riskBefore && run.riskAfter && run.riskAfter.historicalVar95Pct > run.riskBefore.historicalVar95Pct && <p className="risk-tradeoff"><span>Trade-off</span>Concentration decreased, but historical VaR increased on this fixture. A concentration rebalance does not guarantee lower portfolio loss risk.</p>}
    </section>

    <div className="two-column">
      <section className="panel" aria-labelledby="decision-heading">
        <div className="section-heading"><div><div className="eyebrow">03 / Decision</div><h2 id="decision-heading">Independent gates</h2></div></div>
        <div className="proposal">
          <span className="eyebrow">Proposed action</span>
          <strong>{run.action ? `Sell ${run.action.units.toLocaleString("en-US")} ${run.action.assetId}` : "No proposal"}</strong>
          <span className="muted small">{run.action ? `Limit price ${formatMoney(run.action.limitPriceCents)} · proposal only` : "The pipeline did not produce an action."}</span>
        </div>
        <div className="gate-row"><span>Consensus</span><Badge value={run.consensus?.status ?? "NOT_REACHED"} /></div>
        {run.consensus && <>
          <div className="consensus-measure" aria-label={`Support ${formatPercent(run.consensus.support, true)}, threshold ${formatPercent(run.consensus.threshold, true)}`}>
            <div className="support-track"><span style={{ width: `${Math.min(100, Math.max(0, run.consensus.support * 100))}%` }} /><i style={{ left: `${run.consensus.threshold * 100}%` }} /></div>
            <div className="small muted"><span>Support {formatPercent(run.consensus.support, true)}</span><span>Required {formatPercent(run.consensus.threshold, true)}</span></div>
          </div>
          <details className="votes-details"><summary>Inspect votes <span>{run.consensus.votes.length}</span></summary>
            <ul className="votes">{run.consensus.votes.map((vote, index) => <li key={`${vote.agentId}-${index}`}><div><code>{vote.agentId}</code><Badge value={vote.stance} /></div><p>{vote.reason}</p></li>)}</ul>
            <p className="small muted">{run.consensus.duplicateVotesIgnored} duplicate vote(s) ignored. Abstentions do not count as support.</p>
          </details>
        </>}
        <div className="gate-row"><span>Constraints</span><Badge value={constraints} /></div>
        <p className="small muted">Consensus approval does not imply a fill. Constraints and execution are evaluated separately.</p>
      </section>

      <section className="panel" aria-labelledby="execution-heading">
        <div className="section-heading"><div><div className="eyebrow">04 / Execution</div><h2 id="execution-heading">Paper fills & settlement</h2></div><Badge value={execution} /></div>
        {run.fills.length ? run.fills.map((fill) => <div className="fill" key={fill.fillId}>
          <div className="fill-title"><strong>Sold {fill.units.toLocaleString("en-US")} {fill.assetId}</strong><span className="caption">PAPER FILL</span></div>
          <dl className="facts"><div><dt>Fill price</dt><dd>{formatMoney(fill.priceCents)}</dd></div><div><dt>Gross proceeds</dt><dd>{formatMoney(fill.grossCents)}</dd></div><div><dt>Fee</dt><dd>{formatMoney(fill.feeCents)}</dd></div><div><dt>Slippage cost</dt><dd>{formatMoney(fill.slippageCostCents)}</dd></div></dl>
          <div className="identifier">Fill ID <code>{fill.fillId}</code></div>
        </div>) : <div className="empty-fill"><span aria-hidden="true">—</span><strong>No fill recorded</strong><p>The ledger only changes after a successful paper execution.</p></div>}
        <div className="gate-row reconciliation"><span>Reconciliation</span><Badge value={reconciled ? (run.reconciliation.ok ? "PASS" : "FAILED") : "NOT_REACHED"} /></div>
        <dl className="facts compact"><div><dt>Cash movement</dt><dd>{formatMoney(run.reconciliation.cashDeltaCents)}</dd></div><div><dt>Equity change</dt><dd>{formatMoney(run.reconciliation.equityChangeCents)}</dd></div><div><dt>Expected costs</dt><dd>{formatMoney(run.reconciliation.expectedCostCents)}</dd></div><div><dt>Unit accounting</dt><dd>{reconciled ? (run.reconciliation.unitsConserved ? "PASS" : "FAILED") : "NOT REACHED"}</dd></div></dl>
      </section>
    </div>

    <section className="panel audit-panel" aria-labelledby="audit-heading">
      <div className="section-heading"><div><div className="eyebrow">05 / Evidence</div><h2 id="audit-heading">Every stage leaves a receipt</h2></div><span className="caption">{run.audit.length} ordered events</span></div>
      <p className="section-note">A deterministic hash chain links this replay’s events. Expand a stage to inspect its payload and hashes.</p>
      <ol className="audit-timeline">{run.audit.map((event) => <li key={`${event.runId}-${event.sequence}`}>
        <span className={`audit-marker marker--${statusTone(event.status)}`}>{String(event.sequence).padStart(2, "0")}</span>
        <details className="audit-event"><summary><span className="audit-title">{STAGE_LABELS[event.stage]}</span><Badge value={event.status} /><span className="audit-summary">{event.message}</span><span className="expand-label">Inspect <span aria-hidden="true">+</span></span></summary>
          <div className="audit-detail"><dl className="hash-list"><div><dt>Event time</dt><dd>{event.at}</dd></div><div><dt>Tick ID</dt><dd>{event.tickId}</dd></div><div><dt>Previous hash</dt><dd>{event.previousHash}</dd></div><div><dt>Event hash</dt><dd>{event.hash}</dd></div></dl><pre>{JSON.stringify(event.payload, null, 2)}</pre></div>
        </details>
      </li>)}</ol>
      <details className="provenance"><summary>Replay provenance <span>Dataset · policy · audit head</span></summary><dl className="hash-list"><div><dt>Dataset</dt><dd>{run.datasetId}</dd></div><div><dt>Dataset hash</dt><dd>{run.datasetHash}</dd></div><div><dt>Policy hash</dt><dd>{run.policyHash}</dd></div><div><dt>Audit head</dt><dd>{run.auditHead}</dd></div><div><dt>Schema</dt><dd>v{run.schemaVersion}</dd></div></dl></details>
    </section>
  </div>;
}

export function App() {
  const [run, setRun] = useState<PaperRun | null>(null);
  const [scenario, setScenario] = useState<PaperScenarioId>("normal");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async (selected?: PaperScenarioId) => {
    const id = ++requestId.current;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    setPending(true);
    setError("");
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; requestController.abort(); }, 10000);
    try {
      const response = await fetch(selected ? "/api/run" : "/api/state", {
        method: selected ? "POST" : "GET",
        ...(selected ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario: selected }) } : {}),
        cache: "no-store", signal: requestController.signal,
      });
      if (!response.ok) throw new Error(`The replay service returned HTTP ${response.status}.`);
      const state = parsePaperState(await response.json());
      if (id !== requestId.current || requestController.signal.aborted) return;
      setRun(state.run);
      setReceivedAt(new Date().toLocaleTimeString("en-GB"));
    } catch (cause) {
      if (id !== requestId.current) return;
      if (requestController.signal.aborted && !timedOut) return;
      setError(timedOut ? "The replay service did not respond within 10 seconds. Retry when it is available." : cause instanceof Error ? cause.message : "Could not load the replay service.");
    } finally {
      window.clearTimeout(timeout);
      if (id === requestId.current) setPending(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { requestId.current += 1; controller.current?.abort(); };
  }, [load]);

  const selectedScenario = PAPER_SCENARIOS.find((item) => item.id === scenario)!;
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to replay</a>
    <header className="masthead"><a href="#main-content" className="brand" aria-label="RWA Portfolio Manager"><span className="brand-mark" aria-hidden="true">R<span>\</span></span><span>RWA<span className="brand-divider">/</span><span className="brand-subtitle">Portfolio Manager</span></span></a><span className="paper-label"><span aria-hidden="true" />PAPER EXECUTION</span></header>
    <main id="main-content">
      <section className="intro" aria-labelledby="page-heading"><div><div className="eyebrow">Deterministic research environment</div><h1 id="page-heading">Portfolio <em>replay.</em></h1><p>Trace a decision from source data to a reconciled ledger.</p></div><div className="environment-note"><strong>Synthetic data. Real checks.</strong><span>Fixed fixtures · no live funds · no on-chain execution</span></div></section>
      <section className="scenario-control" aria-label="Scenario controls">
        <div className="scenario-field"><label htmlFor="scenario">Choose a scenario</label><select id="scenario" value={scenario} onChange={(event) => setScenario(event.target.value as PaperScenarioId)}>{PAPER_SCENARIOS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
        <p id="scenario-description">{selectedScenario.description}</p>
        <button className="run-button" disabled={pending} aria-describedby="scenario-description" onClick={() => void load(scenario)}>{pending ? "Loading replay…" : "Run replay"}<span aria-hidden="true">↗</span></button>
      </section>
      <div className="request-status" aria-live="polite" role="status"><span>{pending ? (run ? "Running the selected scenario. Previous result remains below." : "Loading the last completed replay…") : error ? "Replay service unavailable" : run ? `Viewing ${PAPER_SCENARIOS.find((item) => item.id === run.scenario)?.title ?? run.scenario}` : "No replay loaded"}</span>{receivedAt && <span>Last received {receivedAt} · local time</span>}</div>
      {error && <div className="error-banner" role="alert"><div><strong>Replay request failed</strong><p>{error}{run ? " The previous result below has not been updated." : " Start the local paper API, then retry."}</p></div><button className="secondary-button" disabled={pending} onClick={() => void load()}>Retry connection</button></div>}
      {run ? <RunResults run={run} /> : <section className="initial-state" aria-busy={pending}><span className="eyebrow">{pending ? "Awaiting evidence" : "No result available"}</span><h2>Risk is <span>UNKNOWN</span></h2><p>A result appears only after the paper service responds. No risk score or execution status has been assumed.</p></section>}
    </main>
    <footer><span>RWA Portfolio Manager <span className="separator">/</span> Research prototype</span><span>Paper outcomes are not investment performance.</span></footer>
  </div>;
}
