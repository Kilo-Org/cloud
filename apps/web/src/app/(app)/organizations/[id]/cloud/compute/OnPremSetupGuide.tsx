import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function OnPremSetupGuide() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base" role="heading" aria-level={3}>
          Prepare → Review → Connect
        </CardTitle>
        <CardDescription>
          Source-built local preview. Review the resources and permissions before creating an
          enrollment. You decide when the CLI installs them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>
          <span className="font-medium">A dedicated cluster is recommended.</span> Do not modify an
          existing shared production cluster, its CNI or its runtime for this setup.
        </p>
        <Accordion type="multiple">
          <AccordionItem value="prepare">
            <AccordionTrigger className="min-h-control-touch py-3 hover:no-underline">
              <span className="min-w-0 space-y-1">
                <span className="block">1. Prepare</span>
                <span className="text-muted-foreground block font-normal">
                  Check the platform requirements and prepare private config.
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-3">
              <ul className="list-disc space-y-3 pl-5">
                <li>
                  Check the single-node Ubuntu ARM64/K3s reference requirements: gVisor, Cilium and
                  2048Mi memory per sandbox allocation. You do not need to create or change a
                  cluster just to inspect the preview. The installer does not create a cloud
                  account, VM or Kubernetes cluster.
                </li>
                <li>
                  Before installation, build the sandbox image with the wrapper and Kilo CLI, and
                  the provisioner image with the trusted provisioner and credential broker, from
                  source. Load both into the Kubernetes node image store. No image publishing is
                  required; public images and a chart are not available.
                </li>
                <li>
                  Prepare a private operator config from{' '}
                  <code className="break-all">operator.local.example.json</code>. Replace its
                  example ports, fixture addresses and image references before generating a preview.
                </li>
              </ul>
              <p className="text-muted-foreground">
                This flow supports the local reference setup, not generic remote clusters.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="review">
            <AccordionTrigger className="min-h-control-touch py-3 hover:no-underline">
              <span className="min-w-0 space-y-1">
                <span className="block">2. Review</span>
                <span className="text-muted-foreground block font-normal">
                  Preview manifests and permissions before creating the ten-minute enrollment.
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-4">
              <div className="space-y-3">
                <p>
                  With <code>$PRIVATE</code> set to your private directory, run from the checkout
                  root:
                </p>
                <pre className="bg-muted rounded-md p-3 font-mono text-xs break-all whitespace-pre-wrap">
                  <code>
                    {
                      'pnpm -C services/cloud-agent-next/onprem run preview:local \\\n  --config "$PRIVATE/operator.json" \\\n  --run-dir "$PRIVATE/review"'
                    }
                  </code>
                </pre>
                <p>
                  This reads only the private operator config. No kubeconfig or token is needed. It
                  makes no cluster calls, generates no certificates and installs nothing. You can
                  inspect a preview before the cluster exists; regenerate it after finalizing the
                  image references and settings.
                </p>
                <p>
                  Open <code className="break-all">$PRIVATE/review/install-preview.json</code> and
                  review every object and permission. This review envelope contains the complete
                  manifest preview and an <code>approvalHash</code>; it cannot be applied to the
                  cluster. Future enrollment IDs, discovered IPs and generated secrets are
                  placeholders, never real credentials.
                </p>
              </div>
              <div className="space-y-2">
                <h4 className="font-medium">Installer permissions and changes</h4>
                <p>
                  The installer adds two dedicated restricted namespaces, named ClusterRole and
                  ClusterRoleBinding, namespaced RBAC, Secrets, ConfigMaps, the broker Service,
                  quotas and limits, NetworkPolicies, and one provisioner/broker Deployment. You
                  need Kubernetes rights to apply these objects.
                </p>
                <p>
                  It reads the cluster version, nodes, RuntimeClass, Cilium DaemonSet and DNS to
                  check compatibility. It does not install or reconfigure CNI, nodes, gVisor or
                  RuntimeClass, or automatically take over existing resources.
                </p>
              </div>
              <div className="space-y-2">
                <h4 className="font-medium">Provisioner service account permissions</h4>
                <p>This runtime grant is separate from the installer permissions:</p>
                <ul className="list-disc space-y-2 pl-5">
                  <li>
                    <span className="font-medium">Trusted namespace:</span> get/update only the
                    named <code className="break-all">kilo-onprem-identity</code> Secret;
                    get/list/create/update/delete allocation ConfigMaps; get the named broker
                    Service.
                  </li>
                  <li>
                    <span className="font-medium">Task namespace:</span>{' '}
                    get/list/create/patch/delete Pods; get/create/delete task Secrets; get the named
                    public CA ConfigMap.
                  </li>
                  <li>
                    <span className="font-medium">Cluster:</span> get the configured{' '}
                    <code>gvisor</code> RuntimeClass; create SelfSubjectAccessReviews to ask
                    Kubernetes about its own rights.
                  </li>
                </ul>
                <p>
                  No <code>cluster-admin</code> or <code>pods/exec</code> grant.
                </p>
              </div>
              <p>
                <code>install:local</code> requires{' '}
                <code className="break-all">{'--approve <reviewed-hash>'}</code>. A missing or
                mismatched hash stops before cluster access or install writes. If config or
                manifests change, generate and review a new preview. Use digest-pinned images for
                final approval; the hash does not freeze the contents of a mutable image tag.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="connect">
            <AccordionTrigger className="min-h-control-touch py-3 hover:no-underline">
              <span className="min-w-0 space-y-1">
                <span className="block">3. Connect</span>
                <span className="text-muted-foreground block font-normal">
                  Enroll, install with your reviewed hash, then wait for Ready.
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <ol className="list-decimal space-y-3 pl-5">
                <li>
                  Only after review, create the ten-minute enrollment below. Save the fields in the
                  private enrollment file described in the setup guide. Keep the token out of shell
                  arguments, source control and logs.
                </li>
                <li>
                  Run <code>install:local</code> explicitly using the six-flag invocation in the
                  setup guide. Supply{' '}
                  <code className="break-all">{'--approve <reviewed-hash>'}</code> with the{' '}
                  <code>approvalHash</code> you reviewed.
                </li>
                <li>
                  Wait until the installation reports <span className="font-medium">Ready</span>{' '}
                  here, then choose <span className="font-medium">Use for new workspaces</span>.
                  Existing workspaces stay pinned to their original compute.
                </li>
              </ol>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <p>Your kubeconfig stays on your machine. It is not uploaded to Kilo.</p>
        <p className="text-muted-foreground">
          Setup guide in this checkout:{' '}
          <code className="break-all">services/cloud-agent-next/onprem/README.md</code>. The{' '}
          <code className="break-all">operator.local.example.json</code> file is in the same
          directory.
        </p>
      </CardContent>
    </Card>
  );
}
