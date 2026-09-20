# Model Service (Hidden Relationship Discovery)

**Archived experiment — excluded from the supported paper workflow and its validation.**
The generated correlations do not establish relationships between real RWA issuers or assets.
The commands below are historical development instructions, not required setup.

MVP FastAPI service that proposes hedge candidates based on detected co-movement.

- For the hackathon, it **simulates** returns and computes correlation.
- Replace `_simulate_returns()` with real price/NAV history (preferably attested via FDC).

Run:
```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8010
```
