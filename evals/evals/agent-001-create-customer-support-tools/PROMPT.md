Turn this agent into a customer support assistant with two tools:

- `lookup_order` accepts a required order ID and returns structured data with
  the order ID, a `paid` status, and a total of `125`.
- `issue_refund` accepts a required order ID and a positive refund amount, and
  returns structured data with the order ID, amount, and a `refunded` status.

Looking up an order must not require approval. Issuing a refund must require
user approval before every execution. Enforce that in the tool definition, not
only in the agent instructions.

Update the instructions so the agent looks up an order before issuing a refund
and explains that the refund requires approval. Ensure the project builds.
