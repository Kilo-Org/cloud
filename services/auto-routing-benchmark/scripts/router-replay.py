import argparse
import collections
from contextlib import contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import socket
import subprocess
from unittest.mock import patch

MINI_REVISION = '04d809ceab9df28f9adaed044884180159172930'

_ledger_spec = importlib.util.spec_from_file_location('router_ledger', Path(__file__).with_name('router-ledger.py'))
CAMPAIGN = importlib.util.module_from_spec(_ledger_spec)
_ledger_spec.loader.exec_module(CAMPAIGN)


def validate_model_config(config, model_settings):
    if not isinstance(model_settings, dict):
        raise ValueError('Pinned default.yaml must define a model mapping')
    for key, expected in model_settings.items():
        if not hasattr(config, key) or getattr(config, key) != expected:
            raise ValueError(f'Replay model configuration differs from pinned default.yaml: {key}')
    if not isinstance(getattr(config, 'action_regex', None), str):
        raise ValueError('Pinned text parser action_regex is unavailable')


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load(path):
    return json.loads(Path(path).read_text())


@contextmanager
def no_network():
    attempts = []

    def deny(*args, **kwargs):
        attempts.append('network_call_denied')
        raise RuntimeError('Receipt replay forbids network access')

    import requests
    with patch.object(socket.socket, 'connect', deny), patch.object(socket.socket, 'connect_ex', deny), patch.object(socket, 'create_connection', deny), patch.object(requests.sessions.Session, 'request', deny):
        yield attempts


def parsers(mini_root):
    mini_root = Path(mini_root).resolve(strict=True)
    revision = subprocess.check_output(['git', '-C', str(mini_root), 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.check_output(['git', '-C', str(mini_root), 'status', '--porcelain', '--untracked-files=no'], text=True).strip()
    if revision != MINI_REVISION or dirty:
        raise ValueError('Replay requires the unchanged pinned mini-SWE-agent source')
    from minisweagent.models.openrouter_textbased_model import OpenRouterTextbasedModel, OpenRouterTextbasedModelConfig
    from minisweagent.models.openrouter_model import OpenRouterModel, OpenRouterModelConfig
    import minisweagent.models.openrouter_textbased_model as text_module
    import minisweagent.models.utils.actions_text as actions_module
    import minisweagent
    import yaml
    default_path = Path(minisweagent.__file__).resolve().parent / 'config' / 'default.yaml'
    if not default_path.resolve(strict=True).is_relative_to(mini_root):
        raise ValueError('Pinned default.yaml escaped the pinned source tree')
    model_settings = yaml.safe_load(default_path.read_text()).get('model')
    if not isinstance(model_settings, dict) or 'model_name' in model_settings:
        raise ValueError('Pinned model settings are incompatible with the live model constructor')
    module_paths = [Path(text_module.__file__).resolve(), Path(actions_module.__file__).resolve(), default_path]
    if any(not path.is_relative_to(mini_root) for path in module_paths):
        raise ValueError('Installed parser does not come from the pinned source tree')
    text = OpenRouterTextbasedModel.__new__(OpenRouterTextbasedModel)
    text.config = OpenRouterTextbasedModelConfig(model_name='offline-replay', **model_settings)
    validate_model_config(text.config, model_settings)
    native = OpenRouterModel.__new__(OpenRouterModel)
    native.config = OpenRouterModelConfig(model_name='offline-replay')
    return text, native, {'revision': revision, 'files': {str(path.relative_to(mini_root)): sha256(path) for path in module_paths}, 'model_settings': model_settings, 'action_regex': text.config.action_regex}


def parse_response(parser, response):
    try:
        actions = parser._parse_actions(response)
        return {'accepted': bool(actions), 'action_count': len(actions), 'error': None}
    except Exception as error:
        return {'accepted': False, 'action_count': None, 'error': type(error).__name__}


def inspect_receipt(receipt, text_parser, native_parser):
    response = receipt.get('response')
    response = response if isinstance(response, dict) else {}
    raw_choices = response.get('choices')
    choices = raw_choices if isinstance(raw_choices, list) else []
    choice = choices[0] if choices and isinstance(choices[0], dict) else {}
    raw_message = choice.get('message')
    message = raw_message if isinstance(raw_message, dict) else {}
    malformed_choice = bool(choices) and (not isinstance(choices[0], dict) or not isinstance(raw_message, dict))
    content = message.get('content')
    content = content if isinstance(content, str) else ''
    usage = response.get('usage') or {}
    usage = usage if isinstance(usage, dict) else {}
    request = receipt.get('request') or {}
    limit = request.get('max_tokens')
    completion = usage.get('completion_tokens')
    length = choice.get('finish_reason') == 'length' or choice.get('native_finish_reason') in {'length', 'max_tokens'}
    native_calls = bool(message.get('tool_calls'))
    raw_markup = bool(re.search(r'<[｜|]DSML[｜|]', content))
    text = parse_response(text_parser, response) if choices and not malformed_choice else None
    native = parse_response(native_parser, response) if native_calls else None
    status = receipt.get('http_status')
    if not receipt.get('dispatch_entered'):
        category = 'not_dispatched'
    elif response.get('error') is not None or type(status) is int and status >= 400:
        category = 'provider_error'
    elif not choices or malformed_choice:
        category = 'missing_or_invalid_provider_response'
    elif choice.get('finish_reason') in {'content_filter', 'refusal'} or choice.get('native_finish_reason') in {'content_filter', 'refusal'} or message.get('refusal'):
        category = 'provider_refusal'
    elif native_calls and native and native['accepted'] and text and not text['accepted']:
        category = 'native_tool_calls_rejected_by_text_transport'
    elif raw_markup and text and not text['accepted']:
        category = 'native_markup_not_accepted_by_text_transport'
    elif length:
        category = 'provider_reported_length'
    elif text and not text['accepted']:
        category = 'text_action_format_rejected'
    else:
        category = 'text_action_accepted'
    return {'request_id': receipt.get('local_request_id'), 'run': receipt.get('run'), 'model': request.get('model'),
            'http_status': status, 'category': category, 'text_parser': text, 'native_parser': native,
            'finish_reason': choice.get('finish_reason'), 'native_finish_reason': choice.get('native_finish_reason'),
            'max_tokens': limit, 'reported_completion_tokens': completion,
            'reported_length_below_requested_limit': length and type(completion) is int and type(limit) is int and completion < limit,
            'native_calls_present': native_calls, 'native_markup_present': raw_markup,
            'request_declares_tools': bool(request.get('tools')), 'response_present': bool(response)}


def grade_error(case, task):
    if not isinstance(case, dict) or type(case.get('resolved')) is not bool:
        return 'missing_resolved_flag'
    if case.get('patch_successfully_applied') is not True:
        return 'patch_not_successfully_applied'
    if not isinstance(task, dict):
        return 'missing_task_test_expectations'
    statuses = case.get('tests_status')
    if not isinstance(statuses, dict):
        return 'missing_test_status'
    failures = []
    for kind in ('FAIL_TO_PASS', 'PASS_TO_PASS'):
        expected = task.get(kind)
        observed = statuses.get(kind)
        if not isinstance(expected, list) or not expected or not all(isinstance(test, str) for test in expected) or not isinstance(observed, dict):
            return 'missing_task_test_expectations_or_status'
        success, failure = observed.get('success'), observed.get('failure')
        if not isinstance(success, list) or not isinstance(failure, list) or not all(isinstance(test, str) for test in success + failure):
            return 'invalid_test_status'
        if sorted(success + failure) != sorted(expected):
            return 'test_coverage_differs_from_task'
        failures.extend(failure)
    if case['resolved'] != (not failures):
        return 'resolved_flag_disagrees_with_tests'
    return None


def grade_case(evaluation, instance, task=None):
    result = evaluation.get('result')
    if isinstance(result, list) and len(result) > 1 and isinstance(result[1], dict):
        case = result[1].get(instance)
        if grade_error(case, task) is None:
            return case['resolved']
    return None


def inspect_rollout(folder, row, receipts, task=None):
    result_path, evaluation_path = folder / 'result.json', folder / 'evaluation.json'
    result = load(result_path) if result_path.is_file() else {}
    evaluation = load(evaluation_path) if evaluation_path.is_file() else {}
    exit_status = (result.get('result') or {}).get('exit_status')
    resolved = grade_case(evaluation, row['instance_id'], task)
    categories = collections.Counter(receipt['category'] for receipt in receipts)
    if evaluation.get('reason') in {'grader_infra_invalid', 'infra_invalid'} or result.get('status') == 'infra_invalid':
        category = 'grader_infrastructure_failure'
    elif evaluation.get('result') is not None and resolved is None:
        category = 'invalid_grade_completeness'
    elif result.get('status') == 'provider_refused' or any(receipt['category'] == 'provider_refusal' for receipt in receipts):
        category = 'provider_refusal'
    elif result.get('status') == 'provider_unavailable' or exit_status == 'ProviderUnavailable':
        category = 'provider_failure'
    elif result.get('status') == 'transport_unknown':
        category = 'unknown_provider_or_transport_outcome'
    elif exit_status == 'RepeatedFormatError':
        category = 'text_transport_compatibility_failure'
    elif result.get('status') == 'budget_limited':
        category = 'protocol_resource_limit'
    elif type(resolved) is bool:
        category = 'observed_task_success' if resolved else 'observed_task_failure'
    else:
        category = 'missing_deterministic_grade'
    return {'run': row['run'], 'router': row['router'], 'instance_id': row['instance_id'], 'configuration': row['configuration'],
            'category': category, 'exit_status': exit_status, 'resolved': resolved, 'receipt_categories': dict(categories),
            'length_below_request_limit_count': sum(receipt['reported_length_below_requested_limit'] for receipt in receipts),
            'model_quality_inference_allowed': False}


def replay(evidence_root, mini_root):
    evidence_root = Path(evidence_root).resolve(strict=True)
    with no_network() as network_attempts:
        text, native, parser_identity = parsers(mini_root)
        receipts, rollouts, missing_receipts = [], [], []
        ledger_requests = solver_requests = classifier_requests = synthetic_requests = 0
        unattributed_requests, task_expectation_evidence = [], {}
        for ledger in sorted(evidence_root.glob('run*/budget.sqlite')):
            directory = ledger.parent
            plan_path = directory / 'execution-plan.json'
            plan = load(plan_path)['runs'] if plan_path.is_file() else []
            by_run = {row['run']: row for row in plan}
            grouped = collections.defaultdict(list)
            with CAMPAIGN.readonly(ledger) as db:
                tables = {item[0] for item in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                kinds = dict(db.execute("SELECT id,kind FROM router_requests")) if 'router_requests' in tables else {}
                all_rows = CAMPAIGN.rows(db)
            ledger_requests += len(all_rows)
            rows = []
            for request in all_rows:
                if CAMPAIGN.synthetic_prior(request):
                    synthetic_requests += 1
                elif kinds.get(request['id']) == 'solver':
                    solver_requests += 1
                    rows.append((request['id'], request['run'], request['receipt']))
                elif kinds.get(request['id']) == 'classifier':
                    classifier_requests += 1
                else:
                    unattributed_requests.append({'ledger': directory.name, 'request_id': request['id']})
            manifest_path = directory / 'router-study-manifest.json'
            manifest = load(manifest_path) if manifest_path.is_file() else {}
            original_panel = manifest.get('panel_root')
            tasks, task_path = {}, None
            if isinstance(original_panel, str) and Path(original_panel).name:
                task_path = evidence_root / Path(original_panel).name / 'evaluator' / 'tasks.json'
                if task_path.is_file() and task_path.resolve().is_relative_to(evidence_root):
                    expected_hash = manifest.get('approval', {}).get('private_tasks_sha256')
                    if expected_hash is not None and sha256(task_path) == expected_hash:
                        tasks = {task['instance_id']: task for task in load(task_path)}
                        task_expectation_evidence[directory.name] = {'path': str(task_path), 'sha256': expected_hash}
            for request_id, run, original_path in rows:
                path = directory / 'receipts' / Path(original_path).name
                if not path.resolve().is_relative_to(directory.resolve()) or not path.is_file():
                    missing_receipts.append({'ledger': directory.name, 'request_id': request_id})
                    continue
                value = inspect_receipt(load(path), text, native)
                value.update(ledger=directory.name, evidence_sha256=sha256(path), baseline=(by_run.get(run) or {}).get('configuration') == 'baseline')
                receipts.append(value)
                grouped[run].append(value)
            for row in plan:
                folder = directory / 'rollouts' / row['run']
                if folder.is_dir():
                    value = inspect_rollout(folder, row, grouped[row['run']], tasks.get(row['instance_id']))
                    value['ledger'] = directory.name
                    rollouts.append(value)
        baseline = [value for value in receipts if value['baseline']]
        summary = {'schema': 'router-receipt-replay-v1', 'network_attempts': network_attempts, 'new_inference_requests': 0,
                   'parser': parser_identity, 'solver_receipts': len(receipts), 'baseline_receipts': len(baseline),
                   'receipt_categories': dict(collections.Counter(value['category'] for value in receipts)),
                   'baseline_receipt_categories': dict(collections.Counter(value['category'] for value in baseline)),
                   'baseline_rollout_categories': dict(collections.Counter(value['category'] for value in rollouts if value['configuration'] == 'baseline')),
                   'reported_length_below_requested_limit': sum(value['reported_length_below_requested_limit'] for value in receipts),
                   'missing_receipts': missing_receipts,
                   'ledger_requests': ledger_requests, 'solver_requests': solver_requests, 'classifier_requests': classifier_requests,
                   'synthetic_prior_requests': synthetic_requests, 'unattributed_requests': len(unattributed_requests),
                   'unattributed_request_rows': unattributed_requests,
                   'receipt_reconciliation': {'ledger_partition_complete': ledger_requests == solver_requests + classifier_requests + synthetic_requests + len(unattributed_requests),
                                              'solver_receipt_accounting_reconciled': solver_requests == len(receipts) + len(missing_receipts),
                                              'solver_receipts_complete': solver_requests > 0 and not missing_receipts and solver_requests == len(receipts),
                                              'all_requests_attributed': not unattributed_requests},
                   'task_expectation_evidence': task_expectation_evidence,
                   'historical_router_quality_claim_allowed': False,
                   'interpretation': 'Parser acceptance and declared provider limits are replayed facts, not new task grades. Native markup without typed tool calls is a format-compatibility observation, not proof the provider returned an executable native tool call. No response, model instruction, task, grader, or past result was changed.'}
        if network_attempts:
            raise RuntimeError('Offline replay attempted network access')
        return summary, receipts, rollouts


def main():
    parser = argparse.ArgumentParser(description='Replay saved solver responses through the pinned parser without network or inference')
    parser.add_argument('--evidence-root', required=True, type=Path)
    parser.add_argument('--mini-root', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    if args.out.resolve().is_relative_to(args.evidence_root.resolve()):
        raise ValueError('Replay output must stay outside immutable evidence')
    summary, receipts, rollouts = replay(args.evidence_root, args.mini_root)
    args.out.mkdir(parents=True, exist_ok=False)
    for name, value in [('report.json', summary), ('receipt-results.json', receipts), ('rollout-results.json', rollouts)]:
        (args.out / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
