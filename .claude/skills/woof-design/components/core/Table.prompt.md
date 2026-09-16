Dense data table for runs, agents, attempts. Mono columns for ids/hashes/counts, right-align numbers.

```jsx
<Table columns={[{key:"runId",label:"Run",mono:true},{key:"status",label:"Status",render:r=><Chip state={r.status}/>}]} rows={runs} rowKey="runId" selected={sel} onSelect={setSel} />
```

`empty` text should say what is missing and where: "No runs in ~/.woof/runs."
