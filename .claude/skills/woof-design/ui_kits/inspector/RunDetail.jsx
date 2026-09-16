// Run detail: overview (status, agents, timeline), journal, artifacts.
const DS2=window.WoofDesignSystem_3b6aec;
const {Card,Chip,Badge,KeyValue,Hash,Timeline,Table,Tabs,JournalLine,Switch,Button,IconButton,Icon,Tooltip,Toast}=DS2;

const ago=iso=>{const d=(Date.parse("2026-09-16T20:41:21.000Z")-Date.parse(iso))/1000;if(d<60)return Math.round(d)+" s ago";if(d<3600)return Math.round(d/60)+" min ago";if(d<86400)return Math.round(d/3600)+" h ago";return "yesterday"};

function StatusBar({run}){
  const active=run.agents.filter(a=>a.active);
  return <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
    <span style={{font:"var(--type-title)",color:"var(--text-primary)"}}>{run.runId}</span>
    <Chip state={run.status}/>
    <span style={{font:"var(--type-mono-sm)",color:"var(--text-muted)"}}>owner</span><Chip state={run.owner} dot={run.owner==="alive"} pulse={run.owner==="alive"}/>
    {run.result&&<Badge>exit {run.result.exit}</Badge>}
    <span style={{flex:1}}/>
    <span style={{font:"var(--type-mono-sm)",color:"var(--text-muted)"}}>{active.length>0?active.map(a=>a.agentId+" → "+a.active).join(" · "):"no active attempt"} · updated <Tooltip label={run.updatedAt}><span>{ago(run.updatedAt)}</span></Tooltip></span>
  </div>;
}

function Attention({run}){
  if(run.blocked){return <div style={{display:"grid",gridTemplateColumns:"16px minmax(0,1fr) auto",gap:12,alignItems:"start",padding:"10px 12px",border:"1px solid var(--state-blocked)",borderRadius:"var(--radius-md)",background:"var(--state-blocked-subtle)"}}><Icon name="alert" size={16} color="var(--state-blocked)" style={{marginTop:2}}/><div><div style={{font:"var(--type-small)",fontWeight:500,color:"var(--text-primary)"}}>Blocked · <code style={{fontSize:12}}>{run.blocked.reason}</code> · {run.blocked.agentId} · since {ago(run.blocked.since)}</div><div style={{font:"var(--type-small)",color:"var(--text-secondary)",marginTop:2}}>{run.blocked.requiredAction}</div><div style={{font:"var(--type-mono-sm)",color:"var(--text-muted)",marginTop:4}}>woof status --wait exits 9 until resolved. Woof never answers the prompt.</div></div><Button size="sm">Mark resolved</Button></div>}
  if(run.result){const t=run.result.outcome==="completed"?"pass":run.result.outcome==="failed"?"fail":run.result.outcome==="exhausted"?"blocked":"lost";return <div style={{display:"grid",gridTemplateColumns:"16px minmax(0,1fr)",gap:12,alignItems:"start",padding:"10px 12px",border:"1px solid var(--border-default)",borderRadius:"var(--radius-md)",background:"var(--bg-surface)"}}><Icon name={t==="pass"?"check":"info"} size={16} color={"var(--state-"+t+")"} style={{marginTop:2}}/><div style={{font:"var(--type-small)",color:"var(--text-secondary)"}}><span style={{color:"var(--text-primary)",fontWeight:500}}>Run {run.result.outcome}.</span> reason <code style={{fontSize:12}}>{run.result.reason}</code>{run.result.limit&&<> · limit <code style={{fontSize:12}}>{run.result.limit}</code> reached ({run.rounds} of {run.maxRounds} rounds)</>} · exit {run.result.exit}{run.owner==="lost"&&<> · owner <code style={{fontSize:12}}>lost</code>: the host stopped heartbeating; the journal holds the recorded outcome.</>}</div></div>}
  return null;
}

function Overview({run,selAttempt,setSelAttempt}){
  const lastGate=run.gates[run.gates.length-1];
  return <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) var(--inspector-width)",gap:16,alignItems:"start"}}>
    <div style={{display:"grid",gap:16}}>
      <Card title="Stage visits" actions={<span style={{font:"var(--type-mono-sm)",color:"var(--text-muted)"}}>round {run.rounds} of {run.maxRounds}</span>}><Timeline items={run.stages} selected={selAttempt} onSelect={k=>setSelAttempt(k)}/></Card>
      <Card title="Agents" padding={0}><Table rows={run.agents} rowKey="agentId" columns={[{key:"agentId",label:"Agent",mono:true},{key:"role",label:"Role",render:r=><Badge mono={false}>{r.role}</Badge>},{key:"kind",label:"Kind · model",mono:true,render:r=>r.kind+" · "+(r.model||"—")},{key:"activity",label:"Activity",render:r=><Chip size="sm" state={r.activity}/>},{key:"active",label:"Attempt",mono:true,render:r=>r.active||<span style={{color:"var(--text-faint)"}}>—</span>},{key:"pane",label:"Pane",mono:true,align:"right",render:r=>r.pane||<span style={{color:"var(--text-faint)"}}>closed</span>}]}/></Card>
    </div>
    <div style={{display:"grid",gap:16}}>
      <Card title="Run"><KeyValue labelWidth={96} items={[{k:"Workflow",v:run.workflow.name+"@"+run.workflow.version},{k:"Task",v:run.task,mono:false},{k:"Repo",v:run.repo},{k:"Opened",v:run.openedAt.slice(0,19).replace("T"," ")},{k:"Host pane",v:run.paneId||"—"},{k:"Heartbeat",v:run.heartbeatMs+" ms"},{k:"Config",v:<Hash prefix="sha256" value={run.configSha}/>}]}/></Card>
      <Card title="Last gate">{lastGate?<KeyValue labelWidth={96} items={[{k:"Gate",v:lastGate.gate},{k:"Decision",v:<Chip size="sm" state={lastGate.decision}/>},{k:"Reason",v:lastGate.reason},{k:"Round",v:"r"+lastGate.round},{k:"At",v:lastGate.at.slice(11,19)}]}/>:<div style={{font:"var(--type-small)",color:"var(--text-muted)"}}>No gate recorded yet.</div>}</Card>
      <Card title="Counters · limits"><KeyValue labelWidth={150} items={[{k:"rounds",v:run.counters.rounds+" / "+run.limits.maxRounds},{k:"attempts",v:run.counters.attempts},{k:"formatRepairs",v:run.counters.formatRepairs+" / "+run.limits.maxFormatRepairs},{k:"rejections",v:run.counters.rejections},{k:"maxAttemptsPerVisit",v:run.limits.maxAttemptsPerVisit},{k:"maxVisitsPerStage",v:run.limits.maxVisitsPerStage},{k:"runTimeoutMs",v:run.limits.runTimeoutMs.toLocaleString("en-US").replace(/,/g," ")},{k:"blockedWaitMs",v:run.limits.blockedWaitMs.toLocaleString("en-US").replace(/,/g," ")}]}/></Card>
    </div>
  </div>;
}

function Journal({run}){
  const [follow,setFollow]=React.useState(run.status==="running");const [sel,setSel]=React.useState(null);const [q,setQ]=React.useState("");
  const ev=run.events.filter(e=>!q||e.type.includes(q)||JSON.stringify(e.subject).includes(q));
  const selected=ev.find(e=>e.seq===sel);
  return <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) var(--inspector-width)",gap:16,alignItems:"start"}}>
    <Card title={<span>journal.jsonl · {run.events.length} records</span>} padding={0} actions={<><DS2.Input mono icon="search" placeholder="type or subject" value={q} onChange={e=>setQ(e.target.value)} width={200} style={{height:24}}/><Switch checked={follow} onChange={e=>setFollow(e.target.checked)} label="Follow"/></>}>
      <div style={{display:"grid",gridTemplateColumns:"40px 96px 180px minmax(0,1fr)",gap:12,padding:"6px 12px",font:"var(--type-label)",letterSpacing:".04em",textTransform:"uppercase",color:"var(--text-muted)",borderBottom:"1px solid var(--border-subtle)"}}><span style={{textAlign:"right"}}>seq</span><span>ts</span><span>type</span><span>subject · data</span></div>
      <div style={{padding:"4px 0"}}>{ev.map(e=><JournalLine key={e.seq} {...e} decision={e.data.decision} selected={e.seq===sel} onClick={()=>setSel(e.seq)}/>)}</div>
      {follow&&<div style={{padding:"6px 12px",borderTop:"1px solid var(--border-subtle)",font:"var(--type-mono-sm)",color:"var(--text-muted)",display:"flex",gap:8,alignItems:"center"}}><Chip size="sm" state="working">following</Chip>cursor {run.events.length}@{run.runId.slice(3)} · tailPending false</div>}
    </Card>
    <Card title={selected?"record "+selected.seq:"record"}>{selected?<div style={{display:"grid",gap:10}}><KeyValue labelWidth={72} items={[{k:"type",v:selected.type},{k:"ts",v:selected.ts},{k:"cursor",v:<Hash value={selected.seq+"@"+run.configSha} length={16}/>}]}/><pre style={{font:"var(--type-mono-sm)",color:"var(--text-secondary)",background:"var(--bg-inset)",border:"1px solid var(--border-subtle)",borderRadius:"var(--radius-sm)",padding:10,whiteSpace:"pre-wrap",wordBreak:"break-all",margin:0}}>{JSON.stringify({schemaVersion:1,kind:"woof.run.event",runId:run.runId,seq:selected.seq,ts:selected.ts,type:selected.type,subject:selected.subject,data:selected.data},null,2)}</pre></div>:<div style={{font:"var(--type-small)",color:"var(--text-muted)"}}>Select a record to see the full envelope. One event per journal record; no synthetic events.</div>}</Card>
  </div>;
}

function Artifacts({run}){
  const [sel,setSel]=React.useState(run.artifacts[0]?run.artifacts[0].path:null);
  const a=run.artifacts.find(x=>x.path===sel);
  const isReview=a&&a.path.endsWith("review.md");
  return <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) var(--inspector-width)",gap:16,alignItems:"start"}}>
    <div style={{display:"grid",gap:16}}>
      <Card title="Accepted artifacts" padding={0} actions={<Button size="sm" variant="ghost" icon="hash">--verify-artifacts</Button>}><Table rows={run.artifacts} rowKey="path" selected={sel} onSelect={k=>setSel(k)} empty={<span>No accepted artifacts. <code>artifacts.review</code> is non-null only when the outcome is <code>completed</code>.</span>} columns={[{key:"path",label:"Path",mono:true},{key:"stage",label:"Attempt",mono:true},{key:"verdict",label:"Verdict",render:r=>r.verdict?<Chip size="sm" state={r.verdict}/>:<span style={{color:"var(--text-faint)"}}>—</span>},{key:"sha256",label:"sha256",render:r=><Hash value={r.sha256}/>},{key:"verified",label:"Integrity",render:r=><span style={{font:"var(--type-mono-sm)",color:r.verified?"var(--state-pass)":"var(--state-fail)"}}>{r.verified?"unaltered":"altered"}</span>},{key:"size",label:"Size",mono:true,align:"right"}]}/></Card>
      {a&&isReview&&run.review&&<Card title={a.path}><pre style={{font:"var(--type-code-block)",margin:0,color:"var(--text-primary)"}}>{run.review.map((l,i)=><div key={i} style={{padding:"0 4px",background:l.startsWith("- ")?"var(--diff-del-bg)":l.startsWith("+ ")?"var(--diff-add-bg)":"transparent",color:l.startsWith("- ")?"var(--diff-del-fg)":l.startsWith("+ ")?"var(--diff-add-fg)":l.startsWith("#")?"var(--text-primary)":"var(--text-secondary)",fontWeight:l.startsWith("#")?500:400}}>{l||" "}</div>)}</pre></Card>}
      {run.diff&&<Card title="repair v1 a1 · working tree · src/title-case.mjs" padding={0}><pre style={{font:"var(--type-code-block)",margin:0}}>{run.diff.map(([k,l],i)=><div key={i} style={{display:"grid",gridTemplateColumns:"20px minmax(0,1fr)",padding:"0 12px",background:k==="add"?"var(--diff-add-bg)":k==="del"?"var(--diff-del-bg)":"transparent",color:k==="add"?"var(--diff-add-fg)":k==="del"?"var(--diff-del-fg)":"var(--text-secondary)"}}><span style={{color:"var(--text-faint)"}}>{k==="add"?"+":k==="del"?"-":" "}</span><span>{l}</span></div>)}</pre></Card>}
    </div>
    <Card title="Receipt">{a?<KeyValue labelWidth={72} items={[{k:"receipt",v:a.receipt},{k:"attempt",v:a.stage},{k:"path",v:a.path},{k:"sha256",v:<Hash value={a.sha256} length={20}/>},{k:"size",v:a.size},{k:"check",v:<span style={{color:a.verified?"var(--state-pass)":"var(--state-fail)"}}>{a.verified?"re-hashed, unaltered":"altered"}</span>}]}/>:<div style={{font:"var(--type-small)",color:"var(--text-muted)"}}>Nothing selected.</div>}</Card>
  </div>;
}
Object.assign(window,{StatusBar,Attention,Overview,Journal,Artifacts});
