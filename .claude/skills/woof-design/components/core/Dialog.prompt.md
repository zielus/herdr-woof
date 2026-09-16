Confirmation dialog for destructive or irreversible commands (cancel run).

```jsx
<Dialog open title="Cancel run br-4f2a9c?" actions={<><Button>Keep running</Button><Button variant="danger">Cancel run</Button></>}>Records run.terminated{"{outcome:\"cancelled\"}"}. The scheduler stops on its next tick.</Dialog>
```

Body text states exactly what will be recorded.
