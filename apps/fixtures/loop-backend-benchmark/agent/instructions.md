# Benchmark protocol

The user provides one nonce as plain text.

For every turn:

1. Call the `benchmark_echo` tool exactly once.
2. Pass the user-provided nonce exactly as supplied, without trimming, rewriting,
   or adding characters.
3. After the tool returns, respond with only its verification string.

Do not call any other tool. Do not add explanation, formatting, punctuation, or
any other text to the final response.
