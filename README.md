# Controle de Custos (MVP) — WID API
Projeto com:
- **/api/preco_wid**: aceita `?product_id=MLB...` ou link com `#...wid=MLB...` e retorna preço do anúncio (WID).
- **index.html**: página estática para testar.
- **vercel.json**: roteamento correto.

### Testes
- `/api/health`
- `/api/ping`
- `/api/preco_wid?product_id=MLB5694522104`

> Usa apenas `/items/{id}` público (sem OAuth).

