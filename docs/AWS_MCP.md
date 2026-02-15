# AWS MCP (Model Context Protocol) Notes

MCP is useful for *development and operations workflows* (your coding assistant can inspect AWS resources, logs, etc.). It is not required to run Garbanzo.

## Recommended: Official AWS MCP Servers

AWS maintains an official set of MCP servers:

- https://github.com/awslabs/mcp

These are intended to be run locally (or in controlled environments) and can give an MCP-capable assistant access to AWS APIs.

## Security Considerations

- Treat MCP access to AWS like handing the assistant AWS credentials.
- Prefer short-lived credentials (SSO) and least-privileged IAM policies.
- Keep a human in the loop for write/destructive actions.

## How We Use This in Garbanzo

Garbanzo itself does not embed MCP today.

For now, MCP is a complementary tool you can use to:

- manage the AWS deployment (EC2, SSM, security groups)
- troubleshoot CloudWatch logs
- audit IAM permissions

If we later add an AWS feature to Garbanzo (e.g., "check my AWS bill"), we should implement it as a narrowly scoped feature with explicit IAM permissions, rather than giving the bot broad AWS account control.
