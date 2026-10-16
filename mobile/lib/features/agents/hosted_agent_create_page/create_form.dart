part of '../hosted_agent_create_page.dart';

String? _optionLabel(
  Map<String, Object?> schema,
  Map<String, String> config,
  String key,
) {
  for (final entry in providerConfigEntries(schema)) {
    if (entry.key != key) continue;
    for (final option
        in providerConfigOptions(entry.value, config) ??
            const <ProviderConfigOption>[]) {
      if (option.value == config[key]) return option.label;
    }
  }
  return null;
}

class _CreateForm extends HookConsumerWidget {
  const _CreateForm({required this.catalog});

  final HostedAgentCatalog catalog;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final schema = catalog.configSchema;
    final initialConfig = useMemoized(() => providerConfigDefaults(schema));
    final config = useState(initialConfig);
    final nameController = useTextEditingController(text: _defaultAgentName);
    final promptController = useTextEditingController(
      text: _defaultAgentInstructions,
    );
    useListenable(nameController);
    useListenable(promptController);
    final preflight = useState(_PreflightState.idle);
    final recheck = useState(0);
    final generation = useRef(0);
    final submitting = useState(false);
    final failure = useState<HostedCreateFailed?>(null);
    final retryingCleanup = useState(false);

    final typedConfig = coerceProviderConfig(config.value, schema);
    final configKey = stableJson(typedConfig);
    final complete = providerConfigComplete(schema, config.value);

    // Re-check owner readiness whenever the configuration settles, when the
    // app returns to the foreground (the owner may have just connected a
    // subscription in the browser), and on "Check again".
    useEffect(() {
      final run = ++generation.value;
      if (!complete) {
        preflight.value = _PreflightState.idle;
        return null;
      }
      final client = ref.read(hostedAgentClientProvider);
      if (client == null) return null;
      preflight.value = _PreflightState(
        key: configKey,
        phase: _PreflightPhase.checking,
      );
      final timer = Timer(const Duration(milliseconds: 350), () async {
        _PreflightState next;
        try {
          final result = await client.preflight(
            catalog: catalog,
            providerConfig: typedConfig,
          );
          next = _PreflightState(
            key: configKey,
            phase: result.ready
                ? _PreflightPhase.ready
                : _PreflightPhase.notReady,
            result: result,
          );
        } on HostedAgentException catch (error) {
          next = _PreflightState(
            key: configKey,
            phase: _PreflightPhase.failed,
            error: error.message,
          );
        } catch (_) {
          next = _PreflightState(
            key: configKey,
            phase: _PreflightPhase.failed,
            error: describeHostedAgentError(''),
          );
        }
        if (run == generation.value && context.mounted) {
          preflight.value = next;
        }
      });
      return timer.cancel;
    }, [configKey, complete, recheck.value]);

    useOnAppLifecycleStateChange((previous, current) {
      if (current == AppLifecycleState.resumed && context.mounted) {
        recheck.value++;
      }
    });

    final name = nameController.text;
    final prompt = promptController.text;
    final nameProblem = name.trim().isEmpty
        ? 'Give the agent a name.'
        : name.trim().length > 256
        ? 'Use a shorter name.'
        : hostedAgentTextProblem(name, label: 'The name');
    final promptProblem =
        utf8.encode(prompt.trim()).length > hostedAgentMaxSystemPromptBytes
        ? 'The instructions are too long.'
        : hostedAgentTextProblem(
            prompt,
            label: 'The instructions',
            multiline: true,
          );
    final canCreate =
        complete &&
        preflight.value.allowsCreate(configKey) &&
        nameProblem == null &&
        promptProblem == null &&
        !submitting.value &&
        !retryingCleanup.value;

    void updateField(String key, String value) {
      failure.value = null;
      config.value = reconcileProviderConfig(
        providerConfigEntries(schema),
        config.value,
        key,
        value,
      );
    }

    Future<void> submit() async {
      if (!canCreate) return;
      unawaited(HapticFeedback.lightImpact());
      submitting.value = true;
      failure.value = null;
      final modelMode = config.value['model_mode'];
      final outcome = await ref
          .read(hostedAgentControllerProvider.notifier)
          .create(
            catalog: catalog,
            draft: HostedAgentDraft(
              displayName: name.trim(),
              systemPrompt: prompt,
              providerConfig: typedConfig,
            ),
            harnessLabel: _optionLabel(schema, config.value, 'harness'),
            modelLabel: modelMode == 'auto'
                ? 'Default model'
                : _optionLabel(schema, config.value, 'model_selector'),
          );
      if (!context.mounted) return;
      submitting.value = false;
      switch (outcome) {
        case HostedCreateSucceeded():
          Navigator.of(context).pop(outcome);
        case HostedCreateFailed():
          failure.value = outcome;
      }
    }

    Future<void> retryCleanup() async {
      final current = failure.value;
      if (current == null) return;
      retryingCleanup.value = true;
      final done = await ref
          .read(hostedAgentControllerProvider.notifier)
          .retryCleanup();
      if (!context.mounted) return;
      retryingCleanup.value = false;
      failure.value = HostedCreateFailed(
        current.error,
        cleanupConfirmed: done,
        cleanupReason: done
            ? null
            : ref.read(hostedAgentControllerProvider).pendingReason,
      );
    }

    final busy = submitting.value || retryingCleanup.value;
    return ListView(
      padding: EdgeInsets.fromLTRB(
        0,
        frostedAppBarHeight(context) + Grid.xs,
        0,
        Grid.lg,
      ),
      children: [
        _WhereItRunsSection(providerName: catalog.providerName),
        const SizedBox(height: Grid.sm),
        _ExecutionFields(
          schema: schema,
          config: config.value,
          enabled: !busy,
          onChanged: updateField,
        ),
        _PreflightStatus(
          state: preflight.value,
          onRecheck: () => recheck.value++,
        ),
        const SizedBox(height: Grid.sm),
        AppListCard(
          label: 'Name and instructions',
          verticalPadding: Grid.twelve,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Grid.xs),
              child: TextField(
                key: const ValueKey('hosted-agent-name'),
                controller: nameController,
                enabled: !busy,
                textCapitalization: TextCapitalization.words,
                maxLength: 256,
                decoration: InputDecoration(
                  labelText: 'Name',
                  counterText: '',
                  errorText: name.isEmpty ? null : nameProblem,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Grid.xs),
              child: TextField(
                key: const ValueKey('hosted-agent-instructions'),
                controller: promptController,
                enabled: !busy,
                minLines: 3,
                maxLines: 8,
                decoration: InputDecoration(
                  labelText: 'Instructions',
                  errorText: promptProblem,
                ),
              ),
            ),
          ],
        ),
        const _Caption('It answers only you to start with.'),
        if (failure.value case final failed?) ...[
          const SizedBox(height: Grid.sm),
          _FailureNotice(
            failure: failed,
            retryingCleanup: retryingCleanup.value,
            onRetryCleanup: () => unawaited(retryCleanup()),
          ),
        ],
        const SizedBox(height: Grid.sm),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Grid.gutter),
          child: FilledButton(
            key: const ValueKey('hosted-agent-create'),
            onPressed: canCreate ? () => unawaited(submit()) : null,
            child: Text(submitting.value ? 'Creating…' : 'Create'),
          ),
        ),
      ],
    );
  }
}
