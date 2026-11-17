import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('router_replay', HERE / 'router-replay.py')
replay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(replay)


def task_expectations():
    return {'instance_id': 'case', 'FAIL_TO_PASS': ['test_fix'], 'PASS_TO_PASS': ['test_retained']}


def complete_case(resolved=True):
    return {'resolved': resolved, 'patch_successfully_applied': True, 'tests_status': {'FAIL_TO_PASS': {'success': ['test_fix'] if resolved else [], 'failure': [] if resolved else ['test_fix']}, 'PASS_TO_PASS': {'success': ['test_retained'], 'failure': []}}}


class ReplayInvariants(unittest.TestCase):
    def test_grade_requires_patch_application_and_exact_expected_test_coverage(self):
        task = task_expectations()
        for resolved in (True, False):
            self.assertEqual(replay.grade_case({'result': [None, {'case': complete_case(resolved)}]}, 'case', task), resolved)
        for change in ({'patch_successfully_applied': False}, {'tests_status': {}}, {'tests_status': {'FAIL_TO_PASS': {'success': ['unrecognized_test'], 'failure': []}, 'PASS_TO_PASS': {'success': ['test_retained'], 'failure': []}}}):
            with self.subTest(change=change):
                case = {**complete_case(), **change}
                self.assertIsNone(replay.grade_case({'result': [None, {'case': case}]}, 'case', task))
        self.assertIsNone(replay.grade_case({'result': [None, {'case': complete_case()}]}, 'case'))
        self.assertIsNotNone(replay.grade_error({**complete_case(), 'resolved': False}, task))

    def test_incomplete_grader_case_is_invalid_not_an_observed_task_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            (folder / 'result.json').write_text(json.dumps({'status': 'completed', 'result': {'exit_status': 'Submitted'}}))
            case = {**complete_case(False), 'patch_successfully_applied': False}
            (folder / 'evaluation.json').write_text(json.dumps({'grade_valid': True, 'result': [None, {'case': case}]}))
            value = replay.inspect_rollout(folder, {'run': 'run', 'instance_id': 'case', 'router': 'efficient', 'configuration': 'baseline'}, [], task_expectations())
            self.assertEqual(value['category'], 'invalid_grade_completeness')
            self.assertIsNone(value['resolved'])

    def test_model_configuration_comparison_rejects_action_regex_drift(self):
        config = SimpleNamespace(action_regex='pinned-action-regex', model_kwargs={'temperature': 0})
        replay.validate_model_config(config, {'action_regex': 'pinned-action-regex', 'model_kwargs': {'temperature': 0}})
        for settings in ({'action_regex': 'different'}, {'unrecognized_setting': True}):
            with self.subTest(settings=settings), self.assertRaisesRegex(ValueError, 'differs'):
                replay.validate_model_config(config, settings)

    def test_replay_reconciles_every_ledger_row_and_only_exact_prior_ids_are_excluded(self):
        with tempfile.TemporaryDirectory() as temporary:
            evidence = Path(temporary) / 'study'
            directory = evidence / 'run'
            (directory / 'receipts').mkdir(parents=True)
            plan = {'runs': [{'run': 'baseline', 'instance_id': 'case', 'router': 'efficient', 'configuration': 'baseline'}]}
            (directory / 'execution-plan.json').write_text(json.dumps(plan))
            identifiers = ['prior-v1-committed', 'prior-committed', 'prior-real', 'missing', 'classifier', 'unattributed']
            with sqlite3.connect(directory / 'budget.sqlite') as db:
                db.execute('CREATE TABLE requests (id TEXT,run TEXT,bound TEXT,actual TEXT,tokens INTEGER,state TEXT,receipt TEXT,token_bound INTEGER)')
                db.execute('CREATE TABLE router_requests (id TEXT,kind TEXT)')
                for request_id in identifiers:
                    db.execute("INSERT INTO requests VALUES (?,'baseline','1','0.25',1,'settled',?,1)", (request_id, f'/home/igor/study/run/receipts/{request_id}.json'))
                    if request_id != 'unattributed':
                        db.execute('INSERT INTO router_requests VALUES (?,?)', (request_id, 'classifier' if request_id == 'classifier' else 'solver'))
            receipt = {'local_request_id': 'prior-real', 'run': 'baseline', 'dispatch_entered': True, 'http_status': 200, 'request': {'model': 'fixture/model'}, 'response': {'choices': [{'message': {'content': 'inert fixture'}, 'finish_reason': 'stop'}]}}
            (directory / 'receipts/prior-real.json').write_text(json.dumps(receipt))
            parser = SimpleNamespace(_parse_actions=lambda response: [{'command': 'not-executed'}])
            before = {str(path): path.read_bytes() for path in evidence.rglob('*') if path.is_file()}
            with mock.patch.object(replay, 'parsers', return_value=(parser, parser, {'fixture': True})):
                summary, receipts, _ = replay.replay(evidence, Path(temporary))
            self.assertEqual(summary['ledger_requests'], 6)
            self.assertEqual(summary['synthetic_prior_requests'], 2)
            self.assertEqual(summary['solver_requests'], 2)
            self.assertEqual(summary['classifier_requests'], 1)
            self.assertEqual(summary['unattributed_requests'], 1)
            self.assertEqual(summary['solver_receipts'], 1)
            self.assertEqual(len(summary['missing_receipts']), 1)
            self.assertEqual(receipts[0]['request_id'], 'prior-real')
            self.assertTrue(summary['receipt_reconciliation']['ledger_partition_complete'])
            self.assertTrue(summary['receipt_reconciliation']['solver_receipt_accounting_reconciled'])
            self.assertFalse(summary['receipt_reconciliation']['solver_receipts_complete'])
            self.assertFalse(summary['receipt_reconciliation']['all_requests_attributed'])
            self.assertEqual(before, {str(path): path.read_bytes() for path in evidence.rglob('*') if path.is_file()})

    def test_infrastructure_failures_never_become_model_quality_failures(self):
        for status, reason in (("completed", "grader_infra_invalid"), ("infra_invalid", "infra_invalid"), ("infra_invalid", None)):
            with self.subTest(status=status, reason=reason), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                (folder / 'result.json').write_text(json.dumps({'status': status, 'result': {'exit_status': 'Submitted'}}))
                (folder / 'evaluation.json').write_text(json.dumps({'reason': reason, 'result': ['case', {'case': {'resolved': False}}]}))
                value = replay.inspect_rollout(folder, {'run': 'run', 'instance_id': 'case', 'router': 'efficient', 'configuration': 'baseline'}, [])
                self.assertEqual(value['category'], 'grader_infrastructure_failure')
                self.assertFalse(value['model_quality_inference_allowed'])


class ReceiptReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = os.environ.get('ROUTER_MINI_ROOT')
        if root is None:
            raise RuntimeError('Set ROUTER_MINI_ROOT to the pinned parser checkout')
        with replay.no_network():
            cls.text, cls.native, cls.identity = replay.parsers(root)

    def receipt(self, message, finish='stop', completion=10, status=200):
        return {'local_request_id': 'fixture', 'run': 'baseline', 'dispatch_entered': True, 'http_status': status,
                'request': {'model': 'fixture/model', 'max_tokens': 16384},
                'response': {'choices': [{'message': message, 'finish_reason': finish}], 'usage': {'completion_tokens': completion}}}

    def inspect(self, receipt):
        with replay.no_network() as attempts:
            value = replay.inspect_receipt(receipt, self.text, self.native)
        self.assertEqual(attempts, [])
        return value

    def test_parser_settings_and_action_regex_are_bound_to_the_pinned_defaults(self):
        replay.validate_model_config(self.text.config, self.identity['model_settings'])
        self.assertEqual(self.identity['action_regex'], self.text.config.action_regex)
        self.assertTrue(any(path.endswith('config/default.yaml') for path in self.identity['files']))

    def test_pinned_text_transport_accepts_one_action_without_executing_it(self):
        value = self.inspect(self.receipt({'content': '```mswea_bash_command\nexit 73\n```'}))
        self.assertEqual(value['category'], 'text_action_accepted')
        self.assertEqual(value['text_parser']['action_count'], 1)

    def test_native_calls_are_not_relabelled_as_task_failure(self):
        message = {'content': '', 'tool_calls': [{'id': 'fixture-call', 'type': 'function', 'function': {'name': 'bash', 'arguments': json.dumps({'command': 'exit 73'})}}]}
        value = self.inspect(self.receipt(message))
        self.assertEqual(value['category'], 'native_tool_calls_rejected_by_text_transport')
        self.assertFalse(value['text_parser']['accepted'])
        self.assertTrue(value['native_parser']['accepted'])
        self.assertFalse(value['request_declares_tools'])

    def test_raw_native_markup_is_not_invented_into_a_tool_call(self):
        value = self.inspect(self.receipt({'content': '<｜DSML｜calls>not a typed tool call'}))
        self.assertEqual(value['category'], 'native_markup_not_accepted_by_text_transport')
        self.assertIsNone(value['native_parser'])

    def test_provider_length_below_the_requested_limit_is_reported_without_rewriting_it(self):
        receipt = self.receipt({'content': '```mswea_bash_command\npwd\n```'}, finish='length', completion=69)
        before = json.dumps(receipt, sort_keys=True)
        value = self.inspect(receipt)
        self.assertEqual(value['category'], 'provider_reported_length')
        self.assertTrue(value['reported_length_below_requested_limit'])
        self.assertEqual(before, json.dumps(receipt, sort_keys=True))

    def test_http_success_with_provider_error_is_a_provider_failure(self):
        receipt = self.receipt({'content': ''})
        receipt['response'] = {'error': {'code': 502, 'message': 'provider unavailable'}}
        self.assertEqual(self.inspect(receipt)['category'], 'provider_error')

    def test_missing_body_and_malformed_message_do_not_invent_actions(self):
        missing = self.receipt({'content': ''})
        missing.pop('response')
        self.assertEqual(self.inspect(missing)['category'], 'missing_or_invalid_provider_response')
        malformed = self.receipt('not a message object')
        value = self.inspect(malformed)
        self.assertIsNone(value['text_parser'])
        self.assertEqual(value['category'], 'missing_or_invalid_provider_response')


    def test_network_guard_denies_transport_without_attempting_a_connection(self):
        with replay.no_network() as attempts:
            with self.assertRaisesRegex(RuntimeError, 'forbids network'):
                socket.create_connection(('127.0.0.1', 1))
        self.assertEqual(attempts, ['network_call_denied'])


if __name__ == '__main__':
    unittest.main()
