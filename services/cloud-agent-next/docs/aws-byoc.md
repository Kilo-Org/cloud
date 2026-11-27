# AWS BYOC

## EC2 sandboxes

Cloud Agent provisions one private `m7i.large` VM per workspace or standalone sandbox.
The VM provides two vCPUs and 8 GiB of memory. Docker runs the workload on the VM.
The customer owns the VPC, VM, encrypted EBS volumes, snapshots, and the launch-document bucket.
The Cloud Agent Worker controls admission and lifecycle. The credential broker keeps SCM tokens outside the workspace.

The VM has no public address or inbound rules. It reads the current launch document from S3 with its IMDSv2 role.
The host passes the workload startup document to Docker on standard input. Host credentials remain outside Docker.
The host redirects workload HTTP and HTTPS through the shared egress policy. Managed Git uses the Worker broker.

An idle stop keeps the VM and disks. The next allocation uses the same workspace disk when it is available.
An enrolled workspace can also capture an independent EBS snapshot after a clean stop.
Cloud Agent uses an eligible workspace snapshot when it must replace a lost disk.
Prepared environment snapshots supply independent disks to new workspaces.
Start fresh and permanent deletion retire the exact workspace generation.
Workspace and environment snapshots can contain private files, so keep them in the enrolled AWS account.

### Publish a release and enroll a connection

1. Build the release workload image for `linux/amd64` with the AWS launch-document loader.
2. Build the host bundle with `node deploy/aws/ec2-host/build-bundle.mjs --image <local-image> --out <new-file>`.
3. Bake a private AL2023 x86-64 AMI with Node, Docker, nftables, dnsmasq, OpenSSL, and ext4 tools.
4. Verify the bundle SHA-256 and run `deploy/aws/ec2-host/install <bundle>` in the AMI build.
5. Share the approved AMI and its encrypted root snapshot with the authorized customer accounts.
6. Publish `deploy/aws/template.ec2.json` in the private release bucket and set the EC2 release manifest and AMI allowlist.
7. Enable the owner in `BYOC_AWS_IDS`. In Cloud Agent Compute settings, create and verify the customer CloudFormation stack.

Set `AWS_EC2_BYOC_RELEASE` to JSON with `format`, `templateVersion`, `template`, `imageId`, and `customerAccounts`.
The `template` field contains `bucket`, `key`, and `sha256`. Add the same AMI ID to `AWS_EC2_HOST_AMI_IDS`.
The controller verifies the customer stack outputs and immutable launch-template version before launch.
Publish a host AMI with a customer-usable encryption key when sharing it across AWS accounts.

## Snapshot selection and cleanup

The shared sandbox interface owns capture and restore requests. The EC2 adapter checks the saved
AWS connection and the storage layout for that installation, then calls EBS. AMI and launch template
updates do not change this storage identity. The wrapper downloads the current runtime at launch.

The host stops the workload and unmounts the data volume before the controller captures the snapshot.
A clean-stop marker confirms the unmount. The controller retires superseded snapshots and snapshots
associated with deleted workspaces or prepared environments. Workspace selection expires after 30 days.

## Host credentials

The host retrieves one instance-scoped launch document. S3 policy uses the EC2 instance ARN from
the host's IMDSv2 role to limit access to its own launch documents and clean-stop markers. The
Docker workload receives its startup document on standard input. The host and Worker use a separate
allocation-scoped credential to check egress policy and authenticate the managed SCM proxy.
