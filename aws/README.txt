AWS files for ContractIQ (v13)

contractiq-bedrock-eu-only.json
  The permissions for the contractiq-bedrock IAM user (go-live guide, step A8).
  Replace YOUR_ACCOUNT_ID in BOTH places with your 12-digit AWS account number.

contractiq-bedrock-us-addition.json
  ONLY for a customer who has agreed US processing in writing (guide, Appendix B).
  Add it as a SECOND inline policy on the same user. Replace YOUR_ACCOUNT_ID twice.

No keys or secrets belong in this folder.
