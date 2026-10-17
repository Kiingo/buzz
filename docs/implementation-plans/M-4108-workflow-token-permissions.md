# M-4108: explicit least-privilege workflow permissions

Goal: fix the eleven reported actions/missing-workflow-permissions findings in
Kiingo/buzz CI without expanding token authority or changing execution. Every
checkbox binds to Mesh M-4108 and outer drain01a11782. Check only observed work.

Base1a1ae140 landed upstream split CI in PR204. Live alert129 is open on
_ci-clients.yml:157 at that source. ci.yml's ten reusable-workflow callers and
_ci-clients.yml's mobile-swift job inherit unspecified workflow permissions.
Existing executable jobs use contents:read, summary jobs use empty permission
maps, and changes alone needs pull-requests:read. Called workflows request no
additional authority. Set contents:read at both workflow roots; retain all
job-specific maps exactly. Preserve .github/kiingo-spot-ci.json, fork guards,
all runner expressions, CI tests disabled, call graph, actions and step bodies.
No application or production Buzz image changes are needed.

- [x] Claim issue before investigation, review current source/alert and all called
      permission maps, and claim two workflow paths plus this plan.
- [x] Add only explicit workflow-root contents:read defaults, without broadening
      any job or altering the Spot admission policy.
- [x] Parse/review full YAML, prove all non-permission structure and existing job
      maps/whole policy bytes unchanged, and complete focused source validation.
- [ ] Commit with DCO and integrate through this repository's normal PR path;
      preserve the upstream sync workstream and exact main workflow admission.
- [ ] Inspect actual accepted source/security analysis or precise remaining
      prerequisite; no software tests on Mac/CI or capacity/profile changes.
- [ ] Reconcile Mesh truthfully, release claims, and remove the clean owned
      checkout/branch after complete delivery.

This workflow change has no application deployment surface. Source/static and
GitHub security analysis are appropriate verification; no runtime test, canary,
new independent test suite or synthetic run is added. Delivery/security-analysis
and cleanup evidence may bind in the external drain ledger without a docs-only
publication. Existing Buzz credential identity is retained; the Kiingo monorepo's
repository-scoped token broker is not an authority source for this fork.

3923/3924 preserve eleven complete baseline/source/control files. YAML1.2
parsing proves both workflow maps are identical after removing only the new
root permissions maps. Each raw diff is exactly three added lines; all25+4job
maps, steps, calls, conditions and runner expressions remain exact. Whole Spot
policy/callee files remain unchanged. Live alerts129–139 are all open against
base1a1ae140 and have the reported rule/paths; no alert was manually dismissed.
