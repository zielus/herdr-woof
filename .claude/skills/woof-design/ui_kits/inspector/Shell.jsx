// Inspector shell: header, runs sidebar, theme toggle.
const DS=window.WoofDesignSystem_3b6aec;
const {Logo,IconButton,Input,Chip,Badge,Button,Tag}=DS;

function Header({theme,onTheme,run,onCancel}){
  return <header style={{height:44,display:"flex",alignItems:"center",gap:16,padding:"0 16px",borderBottom:"1px solid var(--border-default)",background:"var(--bg-surface)",position:"sticky",top:0,zIndex:"var(--z-sticky)"}}>
    <Logo size={24} withName base="../../assets/brand" theme={theme}/>
    <span style={{font:"var(--type-mono-sm)",color:"var(--text-muted)"}}>inspector · read-only · no journal lock, no Herdr</span>
    <span style={{flex:1}}/>
    {run&&run.status!=="completed"&&run.status!=="failed"&&run.status!=="exhausted"&&run.status!=="cancelled"&&<Button size="sm" variant="danger" onClick={onCancel}>Cancel run</Button>}
    <Button size="sm" variant="ghost" icon="terminal">woof runs --all</Button>
    <IconButton icon={theme==="light"?"moon":"sun"} label="Toggle theme" onClick={onTheme}/>
  </header>;
}

function RunsSidebar({runs,selected,onSelect,filter,setFilter}){
  const list=runs.filter(r=>!filter||r.runId.includes(filter)||r.repo.includes(filter)||r.status.includes(filter));
  const active=list.filter(r=>["running","blocked","starting","created"].includes(r.status));
  const ended=list.filter(r=>!active.includes(r));
  const Row=({r})=>{const on=r.runId===selected;return <div onClick={()=>onSelect(r.runId)} style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) auto",gap:8,padding:"8px 12px 8px 14px",cursor:"pointer",background:on?"var(--accent-subtle)":"transparent",boxShadow:on?"inset 2px 0 0 var(--accent)":"none",borderBottom:"1px solid var(--border-subtle)"}}><div style={{minWidth:0}}><div style={{font:"var(--type-mono-sm)",fontWeight:500,color:"var(--text-primary)"}}>{r.runId}</div><div style={{font:"var(--type-small)",color:"var(--text-muted)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.task}</div><div style={{font:"var(--type-mono-sm)",color:"var(--text-faint)",fontSize:11}}>{r.workflow.name} · r{r.rounds}/{r.maxRounds}</div></div><div style={{display:"grid",gap:4,justifyItems:"end",alignContent:"start"}}><Chip size="sm" state={r.status}/><Chip size="sm" state={r.owner} dot={false}/></div></div>};
  const Sec=({t,n})=><div style={{padding:"8px 12px 4px",font:"var(--type-label)",letterSpacing:".04em",textTransform:"uppercase",color:"var(--text-muted)",display:"flex",justifyContent:"space-between"}}><span>{t}</span><span>{n}</span></div>;
  return <aside style={{width:"var(--sidebar-width)",borderRight:"1px solid var(--border-default)",background:"var(--bg-surface)",display:"flex",flexDirection:"column",minHeight:0}}>
    <div style={{padding:8,borderBottom:"1px solid var(--border-subtle)"}}><Input mono icon="search" placeholder="Filter by id, repo, status" value={filter} onChange={e=>setFilter(e.target.value)}/></div>
    <div style={{overflow:"auto",flex:1}}>
      <Sec t="Active" n={active.length}/>{active.map(r=><Row key={r.runId} r={r}/>)}{active.length===0&&<div style={{padding:"4px 12px 12px",font:"var(--type-small)",color:"var(--text-muted)"}}>No active runs.</div>}
      <Sec t="Ended" n={ended.length}/>{ended.map(r=><Row key={r.runId} r={r}/>)}
    </div>
    <div style={{padding:"8px 12px",borderTop:"1px solid var(--border-subtle)",font:"var(--type-mono-sm)",color:"var(--text-faint)",fontSize:11}}>~/.woof/runs · {runs.length} runs · woof v0.1.0</div>
  </aside>;
}
Object.assign(window,{Header,RunsSidebar});
