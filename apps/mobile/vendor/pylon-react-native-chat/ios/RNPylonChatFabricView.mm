#ifdef RCT_NEW_ARCH_ENABLED

#import "RNPylonChatFabricView.h"

#import <react/renderer/components/RNPylonChatSpec/ComponentDescriptors.h>
#import <react/renderer/components/RNPylonChatSpec/EventEmitters.h>
#import <react/renderer/components/RNPylonChatSpec/Props.h>
#import <react/renderer/components/RNPylonChatSpec/RCTComponentViewHelpers.h>

#import <React/RCTConversions.h>
#import <React/RCTFabricComponentsPlugins.h>
#import <React/RCTComponent.h>
#import <WebKit/WebKit.h>

#if __has_include(<RNPylonChat/RNPylonChat-Swift.h>)
#import <RNPylonChat/RNPylonChat-Swift.h>
#else
#import "RNPylonChat-Swift.h"
#endif

using namespace facebook::react;

@interface RNPylonChatFabricView () <RCTRNPylonChatViewViewProtocol>
@end

@implementation RNPylonChatFabricView {
    RNPylonChatView *_swiftView;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
    return concreteComponentDescriptorProvider<RNPylonChatViewComponentDescriptor>();
}

// Kilo patch: opt out of Fabric view recycling. This view wraps a stateful
// WKWebView; a recycled instance keeps stale native state (loaded flags,
// detached event emitter wiring) and never delivers events after a remount.
+ (BOOL)shouldBeRecycled {
    return NO;
}

- (instancetype)initWithFrame:(CGRect)frame {
    if (self = [super initWithFrame:frame]) {
        static const auto defaultProps = std::make_shared<const RNPylonChatViewProps>();
        _props = defaultProps;

        _swiftView = [[RNPylonChatView alloc] initWithFrame:self.bounds];
        _swiftView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
        self.contentView = _swiftView;

        __weak RNPylonChatFabricView *weakSelf = self;

        _swiftView.rctOnPylonLoaded = ^(NSDictionary *body) {
            RNPylonChatFabricView *strongSelf = weakSelf;
            if (strongSelf && strongSelf->_eventEmitter) {
                auto emitter = std::static_pointer_cast<const RNPylonChatViewEventEmitter>(strongSelf->_eventEmitter);
                emitter->onPylonLoaded({});
            }
        };

        _swiftView.rctOnPylonInitialized = ^(NSDictionary *body) {
            RNPylonChatFabricView *strongSelf = weakSelf;
            if (strongSelf && strongSelf->_eventEmitter) {
                auto emitter = std::static_pointer_cast<const RNPylonChatViewEventEmitter>(strongSelf->_eventEmitter);
                emitter->onPylonInitialized({});
            }
        };

        _swiftView.rctOnPylonReady = ^(NSDictionary *body) {
            RNPylonChatFabricView *strongSelf = weakSelf;
            if (strongSelf && strongSelf->_eventEmitter) {
                auto emitter = std::static_pointer_cast<const RNPylonChatViewEventEmitter>(strongSelf->_eventEmitter);
                emitter->onPylonReady({});
            }
        };

        _swiftView.rctOnChatOpened = ^(NSDictionary *body) {
            RNPylonChatFabricView *strongSelf = weakSelf;
            if (strongSelf && strongSelf->_eventEmitter) {
                auto emitter = std::static_pointer_cast<const RNPylonChatViewEventEmitter>(strongSelf->_eventEmitter);
                emitter->onChatOpened({});
            }
        };

        _swiftView.rctOnChatClosed = ^(NSDictionary *body) {
            RNPylonChatFabricView *strongSelf = weakSelf;
            if (strongSelf && strongSelf->_eventEmitter) {
                auto emitter = std::static_pointer_cast<const RNPylonChatViewEventEmitter>(strongSelf->_eventEmitter);
                bool wasOpen = [body[@"wasOpen"] boolValue];
                emitter->onChatClosed({.wasOpen = wasOpen});
            }
        };

        _swiftView.rctOnUnreadCountChanged = ^(NSDictionary *body) {
            RNPylonChatFabricView *strongSelf = weakSelf;
            if (strongSelf && strongSelf->_eventEmitter) {
                auto emitter = std::static_pointer_cast<const RNPylonChatViewEventEmitter>(strongSelf->_eventEmitter);
                int count = [body[@"count"] intValue];
                emitter->onUnreadCountChanged({.count = count});
            }
        };

        _swiftView.rctOnMessageReceived = ^(NSDictionary *body) {
            RNPylonChatFabricView *strongSelf = weakSelf;
            if (strongSelf && strongSelf->_eventEmitter) {
                auto emitter = std::static_pointer_cast<const RNPylonChatViewEventEmitter>(strongSelf->_eventEmitter);
                NSString *message = body[@"message"] ?: @"";
                emitter->onMessageReceived({.message = std::string([message UTF8String])});
            }
        };

        _swiftView.rctOnPylonError = ^(NSDictionary *body) {
            RNPylonChatFabricView *strongSelf = weakSelf;
            if (strongSelf && strongSelf->_eventEmitter) {
                auto emitter = std::static_pointer_cast<const RNPylonChatViewEventEmitter>(strongSelf->_eventEmitter);
                NSString *error = body[@"error"] ?: @"";
                emitter->onPylonError({.error = std::string([error UTF8String])});
            }
        };
    }
    return self;
}

#pragma mark - Touch Forwarding

// Under Fabric, RCTSurfaceTouchHandler (a gesture recognizer on an ancestor surface
// view) intercepts ALL touches and routes them through React's event system. When our
// hitTest returns a native WKWebView, the surface handler captures the touch but has
// nowhere to dispatch it in React, while simultaneously cancelling the WKWebView's
// own gesture recognizers. To fix this, we find the surface touch handler and
// temporarily disable it when our PylonChatView wants to handle the touch.

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
    CGPoint convertedPoint = [self convertPoint:point toView:_swiftView];
    UIView *hitView = [_swiftView hitTest:convertedPoint withEvent:event];
    if (hitView) {
        [self disableSurfaceTouchHandlerIfNeeded];
        return hitView;
    }
    [self enableSurfaceTouchHandler];
    return nil;
}

- (BOOL)pointInside:(CGPoint)point withEvent:(UIEvent *)event {
    return YES;
}

- (void)disableSurfaceTouchHandlerIfNeeded {
    UIGestureRecognizer *handler = [self findSurfaceTouchHandler];
    if (handler && handler.enabled) {
        handler.enabled = NO;
        // Re-enable on next run loop iteration so non-PylonChat touches still work.
        dispatch_async(dispatch_get_main_queue(), ^{
            handler.enabled = YES;
        });
    }
}

- (void)enableSurfaceTouchHandler {
    UIGestureRecognizer *handler = [self findSurfaceTouchHandler];
    if (handler && !handler.enabled) {
        handler.enabled = YES;
    }
}

- (UIGestureRecognizer *)findSurfaceTouchHandler {
    UIView *view = self.superview;
    while (view) {
        for (UIGestureRecognizer *gr in view.gestureRecognizers) {
            if ([NSStringFromClass([gr class]) containsString:@"SurfaceTouchHandler"]) {
                return gr;
            }
        }
        view = view.superview;
    }
    return nil;
}

#pragma mark - Props

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps {
    const auto &newProps = *std::static_pointer_cast<const RNPylonChatViewProps>(props);
    const auto &oldViewProps = *std::static_pointer_cast<const RNPylonChatViewProps>(_props);

    if (newProps.appId != oldViewProps.appId) {
        _swiftView.appId = [NSString stringWithUTF8String:newProps.appId.c_str()];
    }
    if (newProps.widgetBaseUrl != oldViewProps.widgetBaseUrl) {
        _swiftView.widgetBaseUrl = newProps.widgetBaseUrl.empty() ? nil : [NSString stringWithUTF8String:newProps.widgetBaseUrl.c_str()];
    }
    if (newProps.widgetScriptUrl != oldViewProps.widgetScriptUrl) {
        _swiftView.widgetScriptUrl = newProps.widgetScriptUrl.empty() ? nil : [NSString stringWithUTF8String:newProps.widgetScriptUrl.c_str()];
    }
    if (newProps.enableLogging != oldViewProps.enableLogging) {
        _swiftView.enableLogging = newProps.enableLogging;
    }
    if (newProps.debugMode != oldViewProps.debugMode) {
        _swiftView.debugMode = newProps.debugMode;
    }
    if (newProps.primaryColor != oldViewProps.primaryColor) {
        _swiftView.primaryColor = newProps.primaryColor.empty() ? nil : [NSString stringWithUTF8String:newProps.primaryColor.c_str()];
    }
    if (newProps.userEmail != oldViewProps.userEmail) {
        _swiftView.userEmail = newProps.userEmail.empty() ? nil : [NSString stringWithUTF8String:newProps.userEmail.c_str()];
    }
    if (newProps.userName != oldViewProps.userName) {
        _swiftView.userName = newProps.userName.empty() ? nil : [NSString stringWithUTF8String:newProps.userName.c_str()];
    }
    if (newProps.userAvatarUrl != oldViewProps.userAvatarUrl) {
        _swiftView.userAvatarUrl = newProps.userAvatarUrl.empty() ? nil : [NSString stringWithUTF8String:newProps.userAvatarUrl.c_str()];
    }
    if (newProps.userEmailHash != oldViewProps.userEmailHash) {
        _swiftView.userEmailHash = newProps.userEmailHash.empty() ? nil : [NSString stringWithUTF8String:newProps.userEmailHash.c_str()];
    }
    if (newProps.userAccountId != oldViewProps.userAccountId) {
        _swiftView.userAccountId = newProps.userAccountId.empty() ? nil : [NSString stringWithUTF8String:newProps.userAccountId.c_str()];
    }
    if (newProps.userAccountExternalId != oldViewProps.userAccountExternalId) {
        _swiftView.userAccountExternalId = newProps.userAccountExternalId.empty() ? nil : [NSString stringWithUTF8String:newProps.userAccountExternalId.c_str()];
    }
    if (newProps.topInset != oldViewProps.topInset) {
        _swiftView.topInset = @(newProps.topInset);
    }

    [super updateProps:props oldProps:oldProps];
}

#pragma mark - Command Dispatching

- (void)handleCommand:(NSString const *)commandName args:(NSArray const *)args {
    RCTRNPylonChatViewHandleCommand(self, commandName, args);
}

#pragma mark - RCTRNPylonChatViewViewProtocol (Commands)

- (void)openChat {
    [_swiftView openChat];
}

- (void)closeChat {
    [_swiftView closeChat];
}

- (void)showChatBubble {
    [_swiftView showChatBubble];
}

- (void)hideChatBubble {
    [_swiftView hideChatBubble];
}

- (void)showNewMessage:(NSString *)message isHtml:(BOOL)isHtml {
    [_swiftView showNewMessage:message isHtml:isHtml];
}

- (void)updateEmailHash:(NSString *)emailHash {
    [_swiftView updateEmailHash:emailHash];
}

- (void)showTicketForm:(NSString *)slug {
    [_swiftView showTicketForm:slug];
}

- (void)showKnowledgeBaseArticle:(NSString *)articleId {
    [_swiftView showKnowledgeBaseArticle:articleId];
}

- (void)clickElementAtSelector:(NSString *)selector {
    [_swiftView clickElementAtSelector:selector];
}

@end

Class<RCTComponentViewProtocol> RNPylonChatViewCls(void) {
    return RNPylonChatFabricView.class;
}

#endif
