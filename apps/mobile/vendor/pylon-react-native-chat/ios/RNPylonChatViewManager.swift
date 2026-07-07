//
//  RNPylonChatViewManager.swift
//  RNPylonChat
//
//  React Native bridge to PylonChat iOS SDK
//

import Foundation
import UIKit
import React

@objc(RNPylonChatViewManager)
class RNPylonChatViewManager: RCTViewManager {
    
    override static func requiresMainQueueSetup() -> Bool {
        return true
    }
    
    override func view() -> UIView! {
        return RNPylonChatView()
    }
}

